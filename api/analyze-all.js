import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function pct(v) {
  return Number(n(v, 0).toFixed(2));
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function isMoonTradeId(id) {
  return String(id || "").startsWith("moon_");
}

function isMainTradeId(id) {
  return String(id || "").startsWith("main_");
}

function groupStats(rows, keyFn, limit = 15) {
  const map = new Map();

  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;

    const cur = map.get(key) || {
      key,
      count: 0,
      wins: 0,
      losses: 0,
      totalPnlPct: 0,
      totalPnlUsd: 0,
    };

    cur.count += 1;
    cur.totalPnlPct += n(row.pnlPct, 0);
    cur.totalPnlUsd += n(row.pnlUsd, 0);

    if (n(row.pnlPct, 0) >= 0) cur.wins += 1;
    else cur.losses += 1;

    map.set(key, cur);
  }

  return [...map.values()]
    .map((x) => ({
      ...x,
      winRate: x.count ? pct((x.wins / x.count) * 100) : 0,
      avgPnlPct: x.count ? pct(x.totalPnlPct / x.count) : 0,
      totalPnlPct: pct(x.totalPnlPct),
      totalPnlUsd: pct(x.totalPnlUsd),
    }))
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd)
    .slice(0, limit);
}

function buildTradeBook(opened, closed) {
  const openById = new Map();
  for (const ev of safeArray(opened)) {
    if (ev?.id) openById.set(ev.id, ev);
  }

  const closedRows = safeArray(closed).map((ev) => {
    const open = openById.get(ev.id) || null;
    return {
      id: ev.id,
      symbol: up(ev.symbol || open?.symbol),
      side: up(ev.side || open?.side),
      mode: String(ev.mode || open?.mode || ""),
      stage: String(open?.stage || ev?.stage || ""),
      pnlPct: pct(ev.pnlPct),
      pnlUsd: pct(ev.pnlUsd),
      reason: String(ev.reason || ev.exitReason || ""),
      closedAt: n(ev.ts || ev.closedAt, 0),
    };
  });

  const closedIds = new Set(closedRows.map((x) => x.id));
  const liveRows = safeArray(opened)
    .filter((x) => x?.id && !closedIds.has(x.id))
    .map((x) => ({
      id: x.id,
      symbol: up(x.symbol),
      side: up(x.side),
      mode: String(x.mode || ""),
      stage: String(x.stage || ""),
      entryPrice: n(x.entry || x.entryPrice, 0),
      tp: n(x.tp, 0),
      sl: n(x.sl, 0),
      ts: n(x.ts || x.entryAt, 0),
    }))
    .sort((a, b) => b.ts - a.ts);

  const wins = closedRows.filter((x) => n(x.pnlPct, 0) >= 0).length;
  const losses = closedRows.length - wins;

  return {
    summary: {
      opened: safeArray(opened).length,
      closed: closedRows.length,
      live: liveRows.length,
      wins,
      losses,
      winRate: closedRows.length ? pct((wins / closedRows.length) * 100) : 0,
      totalPnlPct: pct(closedRows.reduce((a, b) => a + n(b.pnlPct, 0), 0)),
      totalPnlUsd: pct(closedRows.reduce((a, b) => a + n(b.pnlUsd, 0), 0)),
    },
    recentClosed: closedRows.sort((a, b) => b.closedAt - a.closedAt).slice(0, 20),
    liveTrades: liveRows.slice(0, 20),
    byReason: groupStats(closedRows, (x) => x.reason || "unknown", 10),
    bySymbol: groupStats(closedRows, (x) => x.symbol || "UNKNOWN", 10),
  };
}

function snapshotBlock(latest) {
  if (!latest) return null;

  return {
    regime: latest.regime || "",
    btc: latest.btc || null,
    counts: latest.counts || {},
    topTradeReady: safeArray(latest?.funnel?.trade_ready)
      .sort((a, b) => n(b?.perfectCandidateScore, 0) - n(a?.perfectCandidateScore, 0))
      .slice(0, 10)
      .map((c) => ({
        symbol: c.symbol,
        score: n(c.perfectCandidateScore, 0),
        confidence: n(c.confidence, 0),
        entryQuality: n(c.entryQuality, 0),
        spreadPct: n(c?.ob?.spreadPct, 0),
      })),
    ts: latest.ts || latest.scannedAt || null,
  };
}

export default async function handler(req, res) {
  try {
    const opened = await readEvents("trade_opened", 5000);
    const closed = await readEvents("trade_closed", 5000);

    const allTrades = buildTradeBook(opened, closed);
    const moonTrades = buildTradeBook(
      safeArray(opened).filter((x) => isMoonTradeId(x.id)),
      safeArray(closed).filter((x) => isMoonTradeId(x.id))
    );
    const mainTrades = buildTradeBook(
      safeArray(opened).filter((x) => isMainTradeId(x.id)),
      safeArray(closed).filter((x) => isMainTradeId(x.id))
    );

    const mainBull = await kv.get("main:latest:bull");
    const mainBear = await kv.get("main:latest:bear");
    const moonBull = await kv.get("moon:latest:bull");
    const moonBear = await kv.get("moon:latest:bear");

    res.status(200).json({
      ok: true,
      overview: {
        trades: allTrades.summary,
        main: {
          bull: snapshotBlock(mainBull),
          bear: snapshotBlock(mainBear),
        },
        moon: {
          bull: snapshotBlock(moonBull),
          bear: snapshotBlock(moonBear),
        },
      },
      tradeBooks: {
        all: allTrades,
        main: mainTrades,
        moon: moonTrades,
      },
      ts: Date.now(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}