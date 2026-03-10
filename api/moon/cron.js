import { RUNTIME_CONFIG, requireSecret, tryAcquireMoonScanLock } from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

const fetchFn = globalThis.fetch;

async function hit(url, token) {
  const r = await fetchFn(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "cache-control": "no-cache",
    },
  });

  const text = await r.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }

  if (!r.ok || json?.ok === false) {
    throw new Error(
      `Request failed: ${url} | HTTP ${r.status} | ${json?.error || text.slice(0, 300)}`
    );
  }

  return json;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    let base = process.env.BASE_URL;
    if (!base) {
      const host = req.headers.host;
      if (!host) throw new Error("Missing BASE_URL and no host header");
      base = `https://${host}`;
    } else if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = `https://${base}`;
    }

    if (base.endsWith("/")) base = base.slice(0, -1);

    const token = String(process.env.CRON_SECRET || "");
    if (!token) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET env var" }));
    }

    // overlap voorkomen
    const bullLock = await tryAcquireMoonScanLock("bull", 14 * 60);
    if (!bullLock.ok) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: true,
        cron: true,
        skipped: true,
        reason: "bull lock active",
      }));
    }

    const startedAt = Date.now();

    const bullUrl = `${base}/api/moon/scan?mode=bull`;
    const bearUrl = `${base}/api/moon/scan?mode=bear`;

    const bull = await hit(bullUrl, token);
    const bear = await hit(bearUrl, token);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      cron: true,
      startedAt,
      finishedAt: Date.now(),
      bull: {
        counts: bull?.counts || null,
        btc: bull?.btc || null,
      },
      bear: {
        counts: bear?.counts || null,
        btc: bear?.btc || null,
      },
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: false,
      cron: true,
      error: String(e?.message || e),
    }));
  }
}