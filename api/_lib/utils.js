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

export async function fetchJson(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const headers = { accept: "application/json" };
      if (process.env.COINGECKO_API_KEY) headers["x-cg-pro-api-key"] = process.env.COINGECKO_API_KEY;

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
      const base = 650 + i * 450;
      const extra = (e?.status === 429) ? 1200 : 0;
      await sleep(base + extra);
    }
  }
  throw last;
}

export function percentile(arr, p) {
  const a = (arr || []).filter((v) => Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (a.length === 0) return null;
  const pos = (a.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
  return a[base];
}

export function meanStd(arr) {
  const a = (arr || []).filter((v) => Number.isFinite(v));
  if (a.length < 2) return { mean: 0, std: 1 };
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const varr = a.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (a.length - 1);
  const std = Math.sqrt(varr) || 1;
  return { mean, std };
}
