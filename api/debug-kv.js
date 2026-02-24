// /api/debug-kv.js
import { kv } from "@vercel/kv";
import { requireSecret } from "../lib/_core_bull.js";

export const config = { runtime: "nodejs" };

async function peek(key) {
  try {
    const v = await kv.get(key);

    const type = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    const len = Array.isArray(v) ? v.length : null;

    let sample = v;

    // arrays: laat alleen eerste 2 zien
    if (Array.isArray(v)) sample = v.slice(0, 2);

    // objects: laat alleen key-namen zien (veilig + compact)
    if (type === "object" && v) {
      const keys = Object.keys(v);
      sample = { __keys: keys.slice(0, 50) };
    }

    return { key, exists: v !== null && v !== undefined, type, len, sample };
  } catch (e) {
    return { key, exists: false, error: String(e?.message || e) };
  }
}

export default async function handler(req, res) {
  try {
    // ✅ Jip-en-Janneke: jij gebruikt ?secret=...
    // maar requireSecret kijkt naar ?token=...
    // dus we mappen secret -> token
    const secret = String(req.query?.secret || "");
    if (!req.query?.token && secret) {
      req.query.token = secret;
    }

    // security check
    if (!requireSecret(req, res)) return;

    // je wilde "geef 500" -> we accepteren limit (voor output/log)
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query?.limit || "50"), 10) || 50));

    const keys = [
      // =========================
      // MAIN (zoals jouw output al liet zien)
      // =========================
      "trades:main",
      "events:main",
      "latest:bull",
      "latest:bear",

      // =========================
      // MOON (ECHTE keys uit /lib/_moon_core.js)
      // =========================
      "cc:moon:portfolio:bull",
      "cc:moon:portfolio:bear",
      "cc:moon:positions:bull",
      "cc:moon:positions:bear",
      "cc:moon:latest:bull",
      "cc:moon:latest:bear",
      "cc:moon:state:bull",
      "cc:moon:state:bear",
      "cc:moon:reset:bull",
      "cc:moon:reset:bear",

      // diag snapshots (als je analyzer/diag gebruikt)
      "cc:moon:diag:snap:bull",
      "cc:moon:diag:snap:bear",
      "cc:moon:diag:list:bull",
      "cc:moon:diag:list:bear",

      // signal index (logger)
      "cc:moon:signal:list",
    ];

    // Als je limit=500 doet, dan tonen we dat in output (keys lijst blijft bewust vast)
    const out = [];
    for (const k of keys) out.push(await peek(k));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify(
        {
          ok: true,
          ts: Date.now(),
          limit,
          note:
            "Tip: draai eerst /api/moon/scan?mode=bull&token=... en /api/moon/scan?mode=bear&token=... zodat cc:moon:latest:* gevuld wordt.",
          out,
        },
        null,
        2
      )
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}