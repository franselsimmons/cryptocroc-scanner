// /api/debug-kv.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function requireSecret(req, res) {
  const got = String(req.query?.token || req.headers?.["x-token"] || "");
  const want = String(process.env.CRON_SECRET || process.env.CC_TOKEN || "");

  if (!want) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET (or CC_TOKEN)" }));
    return false;
  }
  if (!got || got !== want) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

async function peek(key) {
  try {
    const v = await kv.get(key);
    const t = Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
    const len = Array.isArray(v) ? v.length : null;

    let sample = v;
    if (Array.isArray(v)) sample = v.slice(0, 2);
    if (t === "object" && v) {
      const keys = Object.keys(v);
      sample = { __keys: keys.slice(0, 20) };
    }

    return { key, exists: v !== null && v !== undefined, type: t, len, sample };
  } catch (e) {
    return { key, exists: false, error: String(e?.message || e) };
  }
}

export default async function handler(req, res) {
  if (!requireSecret(req, res)) return;

  const keys = [
    // MAIN
    "trades:main",
    "events:main",
    "latest:bull",
    "latest:bear",

    // MOON (jouw core keys)
    "moon:portfolio:bull",
    "moon:portfolio:bear",
    "moon:positions:bull",
    "moon:positions:bear",
    "moon:latest:bull",
    "moon:latest:bear",
  ];

  const out = [];
  for (const k of keys) out.push(await peek(k));

  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, ts: Date.now(), out }, null, 2));
}