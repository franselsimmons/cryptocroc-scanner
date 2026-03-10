// /api/moon/public-latest.js

import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  keyMoonLatest,
} from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

function getMode(req) {
  const m = String(req.query?.mode || "bull").toLowerCase();
  return m === "bear" ? "bear" : "bull";
}

function empty(mode) {
  return {
    ok: true,
    ts: Date.now(),
    mode,
    btc: { state: "NEUTRAL", chg24: 0, range24: 0 },
    counts: { elite: 0, almost: 0, buildup: 0, radar: 0 },
    funnel: {
      elite: [],
      almost: [],
      buildup: [],
      radar: [],
    },
    whaleFlow: 0,
  };
}

export default async function handler(req, res) {
  try {
    const mode = getMode(req);
    const key = keyMoonLatest(mode);

    const data = await kv.get(key);

    if (!data) {
      return send(res, 200, empty(mode));
    }

    return send(res, 200, {
      ok: true,
      ts: Number(data.ts || 0) || Date.now(),
      mode,
      btc: data.btc || { state: "NEUTRAL" },
      counts: data.counts || {},
      funnel: {
        elite: data?.funnel?.elite || [],
        almost: data?.funnel?.almost || [],
        buildup: data?.funnel?.buildup || [],
        radar: data?.funnel?.radar || [],
      },
      whaleFlow: Number(data.whaleFlow || 0),
    });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: String(e?.message || e),
    });
  }
}