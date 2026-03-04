// /api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, getMode } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    const mode = getMode(req); // bull/bear
    const modeLc = String(mode).toLowerCase();

    // 1) jouw huidige key (blijft leidend)
    const kPrimary = `latest:${modeLc}`;
    let data = await kv.get(kPrimary);

    // 2) fallback: core.keyLatest(mode) (zonder scan te wijzigen)
    let kCore = null;
    if (!data) {
      try {
        const coreMod = await import(`../lib/_core_${modeLc}.js`);
        const core = coreMod?.default ? coreMod.default : coreMod;
        if (core && typeof core.keyLatest === "function") {
          kCore = core.keyLatest(modeLc);
          if (kCore && kCore !== kPrimary) {
            data = await kv.get(kCore);
          }
        }
      } catch {
        // geen probleem: fallback is best-effort
      }
    }

    // 3) scan lock info (zodat je snapt waarom hij niet update)
    const lockKey = `scan:lock:${modeLc}`;
    const lock = await kv.get(lockKey);
    const now = Date.now();
    const until = Number(lock?.until || 0);
    const active = until > now;

    // als er nog steeds geen data is -> lege response, maar wel debug + lock info
    if (!data) {
      return send(res, 200, {
        ok: true,
        ts: now,
        mode: modeLc,
        btc: null,
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0, openTrades: 0, recentSells: 0 },
        funnel: { entry: [], almost: [], buildup: [], radar: [] },
        trading: { openTrades: [], recentSells: [], stats: {} },
        note: "No latest yet. Run /api/scan with secret once (cron).",
        meta: {
          scanLock: {
            active,
            until: until || null,
            waitMs: active ? Math.max(0, until - now) : 0,
          },
          debugKeys: {
            latestPrimary: kPrimary,
            latestCore: kCore,
            lockKey,
          },
        },
      });
    }

    // 4) Zorg dat meta altijd lock + debugKeys bevat (handig voor support)
    data.meta = data.meta || {};
    data.meta.scanLock = {
      active,
      until: until || null,
      waitMs: active ? Math.max(0, until - now) : 0,
    };
    data.meta.debugKeys = {
      latestPrimary: kPrimary,
      latestCore: kCore,
      lockKey,
    };

    return send(res, 200, data);
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
}