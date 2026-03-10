// /api/moon/public-latest.js

import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  keyMoonLatest,
  getMoonMode,
} from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    const mode = getMoonMode(req);
    const key = keyMoonLatest(mode);
    const data = await kv.get(key);

    const lockKey = `cc:moon:scan_lock:${mode}`;
    const lock = await kv.get(lockKey);
    const now = Date.now();
    const until = Number(lock?.until || 0);
    const active = until > now;

    if (!data) {
      return send(res, 200, {
        ok: true,
        ts: now,
        mode,
        btc: { state: "NEUTRAL", chg24: 0 },
        counts: {
          elite: 0,
          almost: 0,
          buildup: 0,
          radar: 0,
        },
        funnel: {
          elite: [],
          almost: [],
          buildup: [],
          radar: [],
        },
        portfolio: {
          mode,
          posUsd: 50,
          openCount: 0,
          closedCount: 0,
          realizedUsd: 0,
          avgRealizedPct: 0,
          updatedAt: now,
        },
        positions: {
          open: [],
          closed: [],
        },
        whaleFlow: 0,
        note: "No moon latest yet. Run /api/moon/scan?token=CRON_SECRET first or wait for cron.",
        meta: {
          public: true,
          latestKey: key,
          scanLock: {
            active,
            until: until || null,
            waitMs: active ? Math.max(0, until - now) : 0,
          },
        },
      });
    }

    data.meta = data.meta || {};
    data.meta.public = true;
    data.meta.latestKey = key;
    data.meta.scanLock = {
      active,
      until: until || null,
      waitMs: active ? Math.max(0, until - now) : 0,
    };

    return send(res, 200, data);
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: String(e?.message || e),
    });
  }
}