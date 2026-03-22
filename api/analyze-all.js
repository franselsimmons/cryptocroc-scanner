import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import * as moonCore from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

// ===== SAFE FALLBACKS (voorkomt crash bij ontbrekende named exports) =====
const keyMoonDiagList = moonCore.keyMoonDiagList || ((m) => `moon:diag:${m}`);
const keyMoonDiagSnap = moonCore.keyMoonDiagSnap || ((m) => `moon:diag_snap:${m}`);
const keyMoonPositions = moonCore.keyMoonPositions || ((m) => `moon:positions:${m}`);

// ===== HELPERS =====
const n = (x, d = 0) => Number.isFinite(Number(x)) ? Number(x) : d;
const safeArr = (x) => Array.isArray(x) ? x : [];
const inc = (m, k) => m[k] = (m[k] || 0) + 1;

function topN(map, k = 10) {
  return Object.entries(map || {})
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, k);
}

// ===== MAIN FLATTEN =====
function flatten(latest) {
  const f = latest?.funnel || {};
  return [
    ...(f.radar || []),
    ...(f.buildup || []),
    ...(f.almost || []),
    ...(f.entry || []),
    ...(f.elite_ignition || []),
    ...(f.elite_expansion || []),
    ...(f.elite_cascade || []),
  ];
}

function analyzeTrades(events, mode) {
  const e = safeArr(events).filter(x => x.mode === mode);
  let giveback = 0;
  const reasons = {};
  for (const t of e) {
    inc(reasons, t.reason || "UNKNOWN");
    giveback += Math.max(0, n(t.maxPnlPct) - n(t.pnlPct));
  }
  return {
    total: e.length,
    avgGiveback: e.length ? giveback / e.length : 0,
    reasons: topN(reasons, 5),
  };
}

// ===== MOON DIAGS (veilig via fallback) =====
async function readMoon(mode) {
  try {
    const raw = await kv.lrange(keyMoonDiagList(mode), 0, 20);
    return (raw || []).map(x => typeof x === "string" ? JSON.parse(x) : x);
  } catch {
    return [];
  }
}

// ===== HANDLER =====
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const [bull, bear, trades] = await Promise.all([
      kv.get("latest:bull"),
      kv.get("latest:bear"),
      readEvents("trade_closed", 4000),
    ]);

    const bullCoins = flatten(bull);
    const bearCoins = flatten(bear);

    const bullTrades = analyzeTrades(trades, "bull");
    const bearTrades = analyzeTrades(trades, "bear");

    const moonBull = await readMoon("bull");
    const moonBear = await readMoon("bear");

    res.json({
      ok: true,
      main: {
        bull: { coins: bullCoins.length, trades: bullTrades },
        bear: { coins: bearCoins.length, trades: bearTrades },
      },
      moon: {
        bull: { scans: moonBull.length },
        bear: { scans: moonBear.length },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
}