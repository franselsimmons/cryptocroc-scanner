// /api/reset.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// ===== instellingen =====
const PREFIX = "cc:";                // alles van CryptoCroc staat onder cc:
const WARMUP_MINUTES = 25;           // 2 scans (10 min) + beetje speling
const WARMUP_KEY = (mode) => `${PREFIX}warmupUntil:${mode}`; // bull/bear

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // niet aangeraden, maar dan staat reset open
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams.get("secret") || "";
  const auth = req.headers.authorization || "";
  return q === secret || auth === `Bearer ${secret}`;
}

async function delByPrefix(prefix) {
  // @vercel/kv ondersteunt KEYS(pattern)
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

    // 1) delete alles (of per mode)
    let deleted = 0;
    if (mode === "bull") {
      deleted += await delByPrefix(`${PREFIX}bull:`);
      deleted += await delByPrefix(`${PREFIX}ob:bull:`);     // als je OB zo opslaat
      deleted += await delByPrefix(`${PREFIX}latest:bull`);  // als je latest zo opslaat
      deleted += await delByPrefix(`${PREFIX}memory:bull`);  // als je memory zo opslaat
      deleted += await delByPrefix(`${PREFIX}stage:bull:`);  // per coin stages
      deleted += await delByPrefix(`${PREFIX}samples:bull:`);// OB samples
      deleted += await delByPrefix(`${PREFIX}risk:bull`);    // risk state
    } else if (mode === "bear") {
      deleted += await delByPrefix(`${PREFIX}bear:`);
      deleted += await delByPrefix(`${PREFIX}ob:bear:`);
      deleted += await delByPrefix(`${PREFIX}latest:bear`);
      deleted += await delByPrefix(`${PREFIX}memory:bear`);
      deleted += await delByPrefix(`${PREFIX}stage:bear:`);
      deleted += await delByPrefix(`${PREFIX}samples:bear:`);
      deleted += await delByPrefix(`${PREFIX}risk:bear`);
    } else {
      // ALL = alles onder cc:
      deleted += await delByPrefix(PREFIX);
    }

    // 2) warm-up aan (bull + bear)
    const warmupUntil = Date.now() + WARMUP_MINUTES * 60 * 1000;
    await kv.set(WARMUP_KEY("bull"), warmupUntil);
    await kv.set(WARMUP_KEY("bear"), warmupUntil);

    // 3) response + handige links
    const base =
      (req.headers["x-forwarded-proto"] || "https") +
      "://" +
      (req.headers.host || "localhost");

    const secret = process.env.CRON_SECRET || "";

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        deletedKeys: deleted,
        warmupUntil,
        warmupMinutes: WARMUP_MINUTES,
        links: {
          reset_all: `${base}/api/reset?mode=all&secret=${encodeURIComponent(secret)}`,
          reset_bull: `${base}/api/reset?mode=bull&secret=${encodeURIComponent(secret)}`,
          reset_bear: `${base}/api/reset?mode=bear&secret=${encodeURIComponent(secret)}`
        }
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}