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

function safeTs(x) {
  const v = Number(x?.ts || 0);
  return Number.isFinite(v) ? v : 0;
}

export default async function handler(req, res) {
  try {
    const modeLc = String(getMode(req)).toLowerCase().trim(); // bull/bear

    // core ophalen (source-of-truth voor key naming)
    let core = null;
    try {
      const coreMod = await import(`../lib/_core_${modeLc}.js`);
      core = coreMod?.default ? coreMod.default : coreMod;
    } catch {
      core = null;
    }

    // keys
    const kLegacy = `latest:${modeLc}`; // legacy/backward compatibility
    const kCore = core && typeof core.keyLatest === "function" ? core.keyLatest(modeLc) : null;

    // 1) core eerst (veilig)
    let dataCore = null;
    if (kCore) dataCore = await kv.get(kCore);

    // 2) legacy alleen als core leeg is OF legacy duidelijk nieuwer is
    let dataLegacy = null;
    // Alleen opvragen als het zin heeft (scheelt KV calls)
    if (!dataCore || kLegacy !== kCore) {
      dataLegacy = await kv.get(kLegacy);
    }

    let data = dataCore;
    let source = kCore || null;

    if (!dataCore && dataLegacy) {
      data = dataLegacy;
      source = kLegacy;
    } else if (dataCore && dataLegacy && kLegacy !== kCore) {
      // kies de nieuwste op basis van ts
      const tc = safeTs(dataCore);
      const tl = safeTs(dataLegacy);
      if (tl > tc) {
        data = dataLegacy;
        source = kLegacy;
      } else {
        data = dataCore;
        source = kCore;
      }
    }

    // scan lock info (zodat UI verklaart waarom ts niet verandert)
    const lockKey = `scan:lock:${modeLc}`;
    const lock = await kv.get(lockKey);
    const now = Date.now();
    const until = Number(lock?.until || 0);
    const active = until > now;

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
            latestCore: kCore,
            latestLegacy: kLegacy,
            used: source,
            lockKey,
          },
        },
      });
    }

    // inject debug/meta altijd
    data.meta = data.meta || {};
    data.meta.scanLock = {
      active,
      until: until || null,
      waitMs: active ? Math.max(0, until - now) : 0,
    };
    data.meta.debugKeys = {
      latestCore: kCore,
      latestLegacy: kLegacy,
      used: source,
      lockKey,
    };

    return send(res, 200, data);
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
}