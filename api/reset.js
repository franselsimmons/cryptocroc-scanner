// /api/reset.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// Alles van CryptoCroc zit onder deze prefix
const PREFIX = "cc:";

// Warmup: na reset alleen RADAR+BUILDUP vullen, ALMOST/ENTRY/HOLD/SELL leeg
const WARMUP_MINUTES = 25;
const WARMUP_KEY = (mode) => `${PREFIX}warmupUntil:${mode}`; // bull/bear

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;

  // Als je geen secret zet, staat reset open (niet aangeraden)
  if (!secret) return true;

  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams.get("secret") || "";
  const auth = req.headers.authorization || "";

  return q === secret || auth === `Bearer ${secret}`;
}

async function delByPrefix(prefix) {
  // Vercel KV ondersteunt keys(pattern)
  const keys = await kv.keys(`${prefix}*`);
  if (!keys || keys.length === 0) return 0;

  // in batches deleten (veilig)
  const BATCH = 200;
  for (let i = 0; i < keys.length; i += BATCH) {
    await kv.del(...keys.slice(i, i + BATCH));
  }
  return keys.length;
}

export default async function handler(req, res) {
  try {
    if (!isAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const mode = (url.searchParams.get("mode") || "all").toLowerCase(); // bull|bear|all

    let deleted = 0;

    // Simpel en 100% zeker: ALL = alles onder cc:
    // (bull/bear opsplitsen is leuk, maar ALL is het meest “no mistakes”)
    if (mode === "all") {
      deleted += await delByPrefix(PREFIX);
    } else if (mode === "bull") {
      deleted += await delByPrefix(`${PREFIX}bull:`);
      deleted += await delByPrefix(`${PREFIX}stage:bull:`);
      deleted += await delByPrefix(`${PREFIX}samples:bull:`);
      deleted += await delByPrefix(`${PREFIX}ob:bull:`);
      deleted += await delByPrefix(`${PREFIX}latest:bull`);
      deleted += await delByPrefix(`${PREFIX}risk:bull`);
      deleted += await delByPrefix(`${PREFIX}portfolio:bull`);
      // ook warmup key opnieuw zetten hieronder
    } else if (mode === "bear") {
      deleted += await delByPrefix(`${PREFIX}bear:`);
      deleted += await delByPrefix(`${PREFIX}stage:bear:`);
      deleted += await delByPrefix(`${PREFIX}samples:bear:`);
      deleted += await delByPrefix(`${PREFIX}ob:bear:`);
      deleted += await delByPrefix(`${PREFIX}latest:bear`);
      deleted += await delByPrefix(`${PREFIX}risk:bear`);
      deleted += await delByPrefix(`${PREFIX}portfolio:bear`);
    } else {
      // onbekend -> veilig: all
      deleted += await delByPrefix(PREFIX);
    }

    // Warmup altijd aanzetten voor beide modes (veiligste)
    const warmupUntil = Date.now() + WARMUP_MINUTES * 60 * 1000;
    await kv.set(WARMUP_KEY("bull"), warmupUntil);
    await kv.set(WARMUP_KEY("bear"), warmupUntil);

    // Handige links teruggeven
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || "localhost";
    const base = `${proto}://${host}`;

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        deletedKeys: deleted,
        warmup: { minutes: WARMUP_MINUTES, until: warmupUntil },
        links: {
          reset_all: `${base}/api/reset?mode=all&secret=YOUR_CRON_SECRET`,
          reset_bull: `${base}/api/reset?mode=bull&secret=YOUR_CRON_SECRET`,
          reset_bear: `${base}/api/reset?mode=bear&secret=YOUR_CRON_SECRET`
        }
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}