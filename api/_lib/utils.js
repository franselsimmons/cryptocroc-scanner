export const n = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function json(res, obj, code = 200) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

export async function fetchJson(url, tries = 4, baseDelay = 600) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const headers = { accept: "application/json" };
      if (process.env.COINGECKO_API_KEY) {
        headers["x-cg-pro-api-key"] = process.env.COINGECKO_API_KEY;
      }
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        const e = new Error(`HTTP ${r.status} ${t.slice(0, 180)}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } catch (e) {
      last = e;
      // 429 -> wat langer wachten
      const mul = e?.status === 429 ? 2 : 1;
      await sleep(baseDelay * mul * (i + 1));
    }
  }
  throw last;
}

export function rangePct(high, low) {
  const h = n(high), l = n(low);
  if (h == null || l == null || l <= 0) return null;
  return ((h - l) / l) * 100;
}
export function vmRatio(vol, mcap) {
  const v = n(vol), m = n(mcap);
  if (v == null || m == null || m <= 0) return null;
  return v / m;
}
export function ctlProxy(price, high, low) {
  const p = n(price), h = n(high), l = n(low);
  if (p == null || h == null || l == null) return null;
  const d = h - l;
  if (d <= 0) return null;
  return (p - l) / d; // 0..1
}
