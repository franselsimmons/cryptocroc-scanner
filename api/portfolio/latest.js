import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "../../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function safeArr(x) { return Array.isArray(x) ? x : []; }
function up(x) { return String(x || "").toUpperCase(); }
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }

function flattenFunnel(latest) {
  const f = latest?.funnel || {};
  return []
    .concat(safeArr(f.entry))
    .concat(safeArr(f.almost))
    .concat(safeArr(f.buildup))
    .concat(safeArr(f.radar));
}

function findCoinMeta(latest, symbol) {
  const sym = up(symbol);
  return flattenFunnel(latest).find((c) => up(c?.symbol) === sym) || null;
}

function buildOpen(latest, mode) {
  const arr = safeArr(latest?.trading?.openTrades);
  return arr.map((t) => {
    const sym = up(t?.symbol);
    const coin = findCoinMeta(latest, sym);

    const id = `${mode}:${sym}:${n(t?.entryAt, 0) || "open"}`;

    return {
      id,
      symbol: sym,
      funnel: "HOLD",
      mode,
      status: "OPEN",
      openedAt: n(t?.entryAt, 0),
      entryPrice: n(t?.entryPrice, 0),
      lastPrice: n(t?.price, 0),
      pnlPct: n(t?.pnlPct, 0) * 100,
      maxPnlPct: n(t?.maxPnlPct, 0) * 100,

      // Extra metadata voor analyse
      tradePlan: coin?.tradePlan || null,
      stage: coin?.stage || "",
      confidence: n(coin?.confidence, 0),
      gates: coin?.gates || {},
      ob: coin?.ob || {},

      entryMeta: {
        confidence: n(coin?.confidence ?? t?.confidence, 0),
        vm: n(coin?.vm ?? t?.vm, 0),
        obScore: n(coin?.ob?.score, 0),
        spreadPct: n(coin?.ob?.spreadPct, 0),
        depthMinUsd1p: n(coin?.ob?.depthMinUsd1p, 0),
        // GECORRIGEERD: gebruik gates i.p.v. why
        entryGate: String(coin?.gates?.entry || ""),
        almostGate: String(coin?.gates?.almost || ""),
      },
      liveMeta: {
        stage: String(coin?.stage || ""),
        // GECORRIGEERD: obStatus opbouwen uit beschikbare velden
        obStatus: (coin?.ob?.fresh ? 'fresh' : 'stale') + ' / ' + (coin?.ob?.valid ? 'valid' : 'invalid') + (coin?.ob?.reason ? ` (${coin.ob.reason})` : ''),
        obReason: String(coin?.ob?.reason || ""),
      },
    };
  });
}

function buildClosed(latest, mode) {
  const arr = safeArr(latest?.trading?.recentSells);
  return arr.map((s) => {
    const sym = up(s?.symbol);
    const id = `${mode}:${sym}:${n(s?.ts, 0)}`;

    return {
      id,
      symbol: sym,
      funnel: "SELL",
      mode,
      status: "CLOSED",
      closedAt: n(s?.ts, 0),
      entryPrice: n(s?.entryPrice, 0),
      exitPrice: n(s?.exitPrice, 0),
      pnlPct: n(s?.pnlPct, 0) * 100,
      maxPnlPct: n(s?.maxPnlPct, 0) * 100,
      exitReason: String(s?.reason || ""),
      barsOpen: n(s?.barsOpen, 0),
      exitMeta: {},
      improveNotes: "",
    };
  });
}

export default async function handler(req, res) {
  try {
    const [bull, bear] = await Promise.all([
      kv.get("latest:bull"),
      kv.get("latest:bear"),
    ]);

    const open = []
      .concat(buildOpen(bull || {}, "bull"))
      .concat(buildOpen(bear || {}, "bear"));

    const closed = []
      .concat(buildClosed(bull || {}, "bull"))
      .concat(buildClosed(bear || {}, "bear"));

    open.sort((a, b) => n(b?.openedAt, 0) - n(a?.openedAt, 0));
    closed.sort((a, b) => n(b?.closedAt, 0) - n(a?.closedAt, 0));

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      open,
      closed: closed.slice(0, 250),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}