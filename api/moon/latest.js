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
  return String(req.query?.mode || "bull").toLowerCase() === "bear"
    ? "bear"
    : "bull";
}

function emptyLatest(mode) {
  return {
    ok: true,
    ts: Date.now(),
    mode,
    btc: { state: "NEUTRAL", chg24: 0 },
    counts: { elite: 0, almost: 0, buildup: 0, radar: 0 },
    funnel: { elite: [], almost: [], buildup: [], radar: [] },
    portfolio: {
      mode,
      posUsd: 50,
      openCount: 0,
      closedCount: 0,
      realizedUsd: 0,
      avgRealizedPct: 0,
      updatedAt: Date.now(),
    },
    positions: { open: [], closed: [] },
    whaleFlow: 0,
    note: "No moon latest found yet. Run moon pipeline first.",
  };
}

export default async function handler(req, res) {
  try {
    const mode = getMode(req);
    const key = keyMoonLatest(mode);

    const data = await kv.get(key);
    if (!data || typeof data !== "object") {
      return send(res, 200, emptyLatest(mode));
    }

    const out = {
      ok: data.ok !== false,
      ts: Number(data.ts || 0) || Date.now(),
      mode,
      btc: data.btc || { state: "NEUTRAL", chg24: 0 },
      counts: data.counts || { elite: 0, almost: 0, buildup: 0, radar: 0 },
      funnel: {
        elite: Array.isArray(data?.funnel?.elite) ? data.funnel.elite : [],
        almost: Array.isArray(data?.funnel?.almost) ? data.funnel.almost : [],
        buildup: Array.isArray(data?.funnel?.buildup) ? data.funnel.buildup : [],
        radar: Array.isArray(data?.funnel?.radar) ? data.funnel.radar : [],
      },
      portfolio: data.portfolio || emptyLatest(mode).portfolio,
      positions: data.positions || { open: [], closed: [] },
      whaleFlow: Number(data.whaleFlow || 0),
    };

    return send(res, 200, out);
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: String(e?.message || e),
    });
  }
}