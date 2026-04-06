// api/analyze.js
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

function buildTradeAnalytics(opened, closed) {
  const openedArr = safeArray(opened);
  const closedArr = safeArray(closed);

  const openById = new Map();
  for (const ev of openedArr) {
    if (!ev?.id) continue;
    openById.set(ev.id, ev);
  }

  const closedEnriched = closedArr.map((ev) => {
    const open = openById.get(ev.id) || null;
    return {
      id: ev.id,
      symbol: up(ev.symbol || open?.symbol),
      side: up(ev.side || open?.side),
      mode: String(ev.mode || open?.mode || ""),
      source: String(ev.source || open?.source || ""),
      stage: String(ev.stage || open?.stage || ""),
      entryAt: n(open?.ts || open?.entryAt, 0),
      closedAt: n(ev.ts || ev.closedAt, 0),
      entryPrice: n(open?.entry || open?.entryPrice, 0),
      exitPrice: n(ev.exitPrice, 0),
      pnlPct: pct(ev.pnlPct),
      pnlUsd: pct(ev.pnlUsd),
      reason: String(ev.reason || ev.exitReason || ""),
      rr: n(open?.rr, 0),
    };
  });

  const totalClosed = closedEnriched.length;
  const wins = closedEnriched.filter((x) => n(x.pnlPct, 0) >= 0).length;
  const losses = totalClosed - wins;
  const totalPnlPct = closedEnriched.reduce((a, b) => a + n(b.pnlPct, 0), 0);
  const totalPnlUsd = closedEnriched.reduce((a, b) => a + n(b.pnlUsd, 0), 0);

  const grossWinUsd = closedEnriched
    .filter((x) => n(x.pnlUsd, 0) > 0)
    .reduce((a, b) => a + n(b.pnlUsd, 0), 0);

  const grossLossUsdAbs = Math.abs(
    closedEnriched
      .filter((x) => n(x.pnlUsd, 0) < 0)
      .reduce((a, b) => a + n(b.pnlUsd, 0), 0)
  );

  const avgWinPct = wins
    ? pct(
        closedEnriched
          .filter((x) => n(x.pnlPct, 0) >= 0)
          .reduce((a, b) => a + n(b.pnlPct, 0), 0) / wins
      )
    : 0;

  const avgLossPct = losses
    ? pct(
        closedEnriched
          .filter((x) => n(x.pnlPct, 0) < 0)
          .reduce((a, b) => a + n(b.pnlPct, 0), 0) / losses
      )
    : 0;

  const closedIds = new Set(closedEnriched.map((x) => x.id));
  const liveTrades = openedArr
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

  return {
    summary: {
      totalOpened: openedArr.length,
      totalClosed,
      live: liveTrades.length,
      wins,
      losses,
      winRate: totalClosed ? pct((wins / totalClosed) * 100) : 0,
      totalPnlPct: pct(totalPnlPct),
      totalPnlUsd: pct(totalPnlUsd),
      avgPnlPct: totalClosed ? pct(totalPnlPct / totalClosed) : 0,
      avgWinPct,
      avgLossPct,
      profitFactor: grossLossUsdAbs > 0 ? pct(grossWinUsd / grossLossUsdAbs) : grossWinUsd > 0 ? 999 : 0,
    },
    byReason: groupStats(closedEnriched, (x) => x.reason || "unknown").slice(0, 20),
    bySymbol: groupStats(closedEnriched, (x) => x.symbol || "UNKNOWN").slice(0, 20),
    recentClosed: closedEnriched.sort((a, b) => b.closedAt - a.closedAt).slice(0, 50),
    liveTrades: liveTrades.slice(0, 50),
  };
}

export default async function handler(req, res) {
  try {
    const opened = await readEvents("trade_opened", 5000);
    const closed = await readEvents("trade_closed", 5000);

    const all = buildTradeAnalytics(opened, closed);
    const moon = buildTradeAnalytics(
      safeArray(opened).filter((x) => isMoonTradeId(x.id)),
      safeArray(closed).filter((x) => isMoonTradeId(x.id))
    );
    const main = buildTradeAnalytics(
      safeArray(opened).filter((x) => isMainTradeId(x.id)),
      safeArray(closed).filter((x) => isMainTradeId(x.id))
    );

    const mainBull = await kv.get("main:latest:bull");
    const mainBear = await kv.get("main:latest:bear");
    const moonBull = await kv.get("moon:latest:bull");
    const moonBear = await kv.get("moon:latest:bear");

    res.status(200).json({
      ok: true,
      all,
      systems: {
        main,
        moon,
      },
      snapshots: {
        main: {
          bull: mainBull || null,
          bear: mainBear || null,
        },
        moon: {
          bull: moonBull || null,
          bear: moonBear || null,
        },
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