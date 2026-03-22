// /api/analyze-all.js
import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// ===================== HELPERS =====================
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function safeArr(x) { return Array.isArray(x) ? x : []; }
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function inc(map, key) { const k = String(key || "unknown"); map[k] = (map[k] || 0) + 1; }
function topN(map, k = 12) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function fmtDate(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "n/a";
  return d.toLocaleString("nl-NL");
}
function addCounts(to, from) {
  const out = to || {};
  const src = from || {};
  for (const k of Object.keys(src)) out[k] = (out[k] || 0) + n(src[k], 0);
  return out;
}

// ===================== MOON KEY FIX =====================
function keyMoonDiagList(mode) {
  return `moon:diag:${String(mode || "bull").toLowerCase()}:list`;
}
function keyMoonDiagSnap(mode) {
  return `moon:diag:${String(mode || "bull").toLowerCase()}:snap`;
}
function keyMoonPositions(mode) {
  return `moon:positions:${String(mode || "bull").toLowerCase()}`;
}

// ===================== MAIN =====================
function safeStage(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "object") return Object.values(x);
  return [];
}

function flattenMainCoins(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeStage(f.radar),
    ...safeStage(f.buildup),
    ...safeStage(f.almost),
    ...safeStage(f.entry),
    ...safeStage(f.elite_ignition),
    ...safeStage(f.elite_expansion),
    ...safeStage(f.elite_cascade),
  ];
}

function summarizeMainSnapshot(latest) {
  const coins = flattenMainCoins(latest || {});
  const stageCounts = { RADAR: 0, BUILDUP: 0, ALMOST: 0, ENTRY: 0, ELITE: 0 };

  for (const c of coins) {
    const s = String(c?.stage || "").toUpperCase();
    if (stageCounts[s] !== undefined) stageCounts[s]++;
    if (s.includes("ELITE")) stageCounts.ELITE++;
  }

  return { ts: latest?.ts || null, stageCounts };
}

function analyzeMainBottlenecks(coins) {
  const fails = {};
  const status = {};

  for (const c of coins) {
    inc(status, c?.tradeDeskStatus || "UNKNOWN");

    const checklist = c?.execution?.checklist || [];
    for (const item of checklist) {
      if (item?.ok === false) {
        inc(fails, String(item?.name || "unknown").toLowerCase());
      }
    }
  }

  return {
    topChecklistFails: topN(fails, 8),
    tradeDeskStatusCounts: topN(status, 8),
  };
}

function analyzeMainTrades(events, mode) {
  const closes = safeArr(events).filter(
    (e) => !mode || String(e?.mode || "").toLowerCase() === mode
  );

  const exitReasons = {};
  let giveback = 0;

  for (const t of closes) {
    inc(exitReasons, t?.reason || "UNKNOWN");
    giveback += Math.max(0, n(t?.maxPnlPct) - n(t?.pnlPct));
  }

  return {
    exitReasons: topN(exitReasons, 8),
    avgGiveback: closes.length ? giveback / closes.length : 0,
    totalTrades: closes.length,
  };
}

// ===================== MOON =====================
async function readMoonDiags(mode) {
  try {
    const raw = await kv.lrange(keyMoonDiagList(mode), 0, 19);
    return (raw || []).map(x => typeof x === "string" ? JSON.parse(x) : x);
  } catch {
    return [];
  }
}

function summarizeMoonDiags(diags) {
  const s = { avg: { radar: 0, buildup: 0, almost: 0, elite: 0 }, totals: { eliteWhy: {} } };
  if (!diags.length) return s;

  for (const d of diags) {
    const r = d?.reasons || {};
    s.totals.eliteWhy = addCounts(s.totals.eliteWhy, r.eliteWhy);
  }

  return s;
}

async function readMoonPositions(mode) {
  try {
    const p = await kv.get(keyMoonPositions(mode));
    return { open: p?.open || [], closed: p?.closed || [] };
  } catch {
    return { open: [], closed: [] };
  }
}

function summarizeMoonTrades(pos) {
  const map = {};
  for (const p of pos.closed) {
    inc(map, p?.exitKind || "CLOSED");
  }
  return { counts: { open: pos.open.length, closed: pos.closed.length }, outcomesTop: topN(map, 8) };
}

// ===================== HANDLER =====================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const [bullLatest, bearLatest, tradeClosed] = await Promise.all([
      kv.get("latest:bull"),
      kv.get("latest:bear"),
      readEvents("trade_closed", 4000),
    ]);

    const mainBullCoins = flattenMainCoins(bullLatest);
    const mainBearCoins = flattenMainCoins(bearLatest);

    const mainBullSnapshot = summarizeMainSnapshot(bullLatest);
    const mainBearSnapshot = summarizeMainSnapshot(bearLatest);

    const mainBullBottlenecks = analyzeMainBottlenecks(mainBullCoins);
    const mainBearBottlenecks = analyzeMainBottlenecks(mainBearCoins);

    const mainBullTrades = analyzeMainTrades(tradeClosed, "bull");
    const mainBearTrades = analyzeMainTrades(tradeClosed, "bear");

    const [moonBullDiags, moonBearDiags, moonBullPos, moonBearPos] =
      await Promise.all([
        readMoonDiags("bull"),
        readMoonDiags("bear"),
        readMoonPositions("bull"),
        readMoonPositions("bear"),
      ]);

    const html = `
      <html><body style="background:#0b0f14;color:white;font-family:sans-serif;padding:20px">
      <h1>Analyze ALL OK ✅</h1>
      <h2>Main Bull Trades: ${mainBullTrades.totalTrades}</h2>
      <h2>Main Bear Trades: ${mainBearTrades.totalTrades}</h2>
      <h2>Moon Bull Open: ${moonBullPos.open.length}</h2>
      <h2>Moon Bear Open: ${moonBearPos.open.length}</h2>
      </body></html>
    `;

    res.setHeader("content-type", "text/html");
    res.status(200).end(html);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}