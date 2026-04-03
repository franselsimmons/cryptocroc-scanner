// api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyMainLatest } from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

// scannedAt heeft voorrang, ts fallback
function snapshotTs(latest) {
  const s = n(latest?.scannedAt, 0);
  if (s > 0) return s;
  return n(latest?.ts, 0);
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
    const latest = (await kv.get(keyMainLatest(mode))) || null;

    // ============================
    // Lege response (scanner-only)
    // ============================
    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        btc: { state: "NEUTRAL", chg24: 0, range24: 0 },
        funnel: {
          tradeReady: [], // scanner ENTRY / OPEN
          almost: [],
          buildup: [],
          radar: [],
        },
        counts: {
          tradeReady: 0,
          almost: 0,
          buildup: 0,
          radar: 0,
        },
      });
    }

    // ============================
    // Normalize funnel (scanner-only)
    // ============================
    const funnel = latest?.funnel || {};

    const eliteExpansion = arr(funnel.elite_expansion);
    const eliteIgnition = arr(funnel.elite_ignition);

    // Scanner "tradeReady" = alles wat jij als entry/ready wil tonen.
    // In jouw huidige backend-logica is dat elite_expansion + elite_ignition.
    const tradeReady = eliteExpansion.concat(eliteIgnition);

    const almost = arr(funnel.almost);
    const buildup = arr(funnel.buildup);
    const radar = arr(funnel.radar);

    const ts = snapshotTs(latest);

    // ============================
    // Response
    // ============================
    return res.status(200).json({
      // let op: we nemen latest mee, maar overschrijven funnel + counts + timestamps
      ...latest,

      // timestamps netjes
      ts,
      scannedAt: n(latest?.scannedAt, ts),

      // btc fallback
      btc: latest?.btc || { state: "NEUTRAL", chg24: 0, range24: 0 },

      // scanner-only funnel
      funnel: {
        tradeReady,
        almost,
        buildup,
        radar,
      },

      // scanner-only counts
      counts: {
        tradeReady: tradeReady.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "latest_failed",
    });
  }
}