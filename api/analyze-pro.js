// api/analyze-pro.js
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

function groupStats(rows, keyFn) {
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
      avgPnlUsd: x.count ? pct(x.totalPnlUsd / x.count) : 0,
      totalPnlPct: pct(x.totalPnlPct),
      totalPnlUsd: pct(x.totalPnlUsd),
    }))
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
}

export default async function handler(req, res) {
  try {
    const openedRaw = await readEvents("trade_opened", 5000);
    const closedRaw = await readEvents("trade_closed", 5000);

    const opened = safeArray(openedRaw).filter((x) => isMoonTradeId(x.id));
    const closed = safeArray(closedRaw).filter((x) => isMoonTradeId(x.id));

    const openById = new Map();
    for (const ev of opened) {
      if (ev?.id) openById.set(ev.id, ev);
    }

    const rows = closed.map((ev) => {
      const open = openById.get(ev.id) || null;
      return {
        id: ev.id,
        symbol: up(ev.symbol || open?.symbol),
        side: up(ev.side || open?.side),
        mode: String(ev.mode || open?.mode || ""),
        entryPrice: n(open?.entry || open?.entryPrice, 0),
        exitPrice: n(ev.exitPrice, 0),
        pnlPct: pct(ev.pnlPct),
        pnlUsd: pct(ev.pnlUsd),
        reason: String(ev.reason || ev.exitReason || ""),
        stage: String(open?.stage || ev?.stage || ""),
        rr: n(open?.rr, 0),
        closedAt: n(ev.ts || ev.closedAt, 0),
      };
    });

    const wins = rows.filter((x) => n(x.pnlPct, 0) >= 0);
    const losses = rows.filter((x) => n(x.pnlPct, 0) < 0);

    const closedIds = new Set(rows.map((x) => x.id));
    const live = opened
      .filter((x) => x?.id && !closedIds.has(x.id))
      .map((x) => ({
        id: x.id,
        symbol: up(x.symbol),
        side: up(x.side),
        mode: String(x.mode || ""),
        entryPrice: n(x.entry || x.entryPrice, 0),
        tp: n(x.tp, 0),
        sl: n(x.sl, 0),
        rr: n(x.rr, 0),
        ts: n(x.ts || x.entryAt, 0),
      }))
      .sort((a, b) => b.ts - a.ts);

    res.status(200).json({
      ok: true,
      summary: {
        totalOpened: opened.length,
        totalClosed: rows.length,
        live: live.length,
        wins: wins.length,
        losses: losses.length,
        winRate: rows.length ? pct((wins.length / rows.length) * 100) : 0,
        totalPnlPct: pct(rows.reduce((a, b) => a + n(b.pnlPct, 0), 0)),
        totalPnlUsd: pct(rows.reduce((a, b) => a + n(b.pnlUsd, 0), 0)),
        avgPnlPct: rows.length ? pct(rows.reduce((a, b) => a + n(b.pnlPct, 0), 0) / rows.length) : 0,
      },
      byReason: groupStats(rows, (x) => x.reason || "unknown").slice(0, 20),
      bySymbol: groupStats(rows, (x) => x.symbol || "UNKNOWN").slice(0, 20),
      byStage: groupStats(rows, (x) => x.stage || "UNKNOWN").slice(0, 20),
      recentClosed: rows.sort((a, b) => b.closedAt - a.closedAt).slice(0, 50),
      liveTrades: live.slice(0, 50),
      ts: Date.now(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}