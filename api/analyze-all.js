import { kv } from "@vercel/kv";
import { readTradeEventBook, inferSystemFromTradeId } from "../lib/_analytics.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function pct(v) {
  return Number(n(v, 0).toFixed(2));
}

function bucketNumber(v, steps = [40, 50, 60, 70, 80]) {
  const x = n(v, 0);
  if (x < steps[0]) return `<${steps[0]}`;
  for (let i = 0; i < steps.length - 1; i++) {
    if (x >= steps[i] && x < steps[i + 1]) return `${steps[i]}-${steps[i + 1] - 1}`;
  }
  return `${steps[steps.length - 1]}+`;
}

function bucketSpread(v) {
  const x = n(v, 999);
  if (x < 0.4) return "<0.40";
  if (x < 0.8) return "0.40-0.79";
  if (x < 1.2) return "0.80-1.19";
  if (x < 1.6) return "1.20-1.59";
  return "1.60+";
}

function bucketOb(v) {
  const x = n(v, 0);
  if (x <= -0.05) return "<=-0.05";
  if (x < 0) return "-0.05-0";
  if (x < 0.05) return "0-0.04";
  return "0.05+";
}

function groupStats(rows, keyFn, limit = 20) {
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
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function buildSummary(rows) {
  const wins = rows.filter((x) => n(x.pnlPct, 0) >= 0).length;
  const losses = rows.length - wins;
  const totalPnlPct = rows.reduce((a, b) => a + n(b.pnlPct, 0), 0);
  const totalPnlUsd = rows.reduce((a, b) => a + n(b.pnlUsd, 0), 0);

  return {
    trades: rows.length,
    wins,
    losses,
    winRate: rows.length ? pct((wins / rows.length) * 100) : 0,
    totalPnlPct: pct(totalPnlPct),
    totalPnlUsd: pct(totalPnlUsd),
    avgPnlPct: rows.length ? pct(totalPnlPct / rows.length) : 0,
  };
}

function buildTeacher(summary, byReason, byEntryQuality, byPersistence, bySpread) {
  const lessons = [];

  const timeout = byReason.find((x) => x.key === "timeout");
  const stopLoss = byReason.find((x) => x.key === "sl" || x.key === "stop_loss");
  const thesisBreak = byReason.find((x) => x.key === "thesis_break");

  if (n(summary.winRate) < 45) {
    lessons.push({
      type: "improve",
      text: "Winrate is te laag. Maak entries strenger en laat alleen sterkere setups door.",
    });
  }

  if (timeout && n(timeout.avgPnlPct) < -1) {
    lessons.push({
      type: "improve",
      text: "Timeout verliest gemiddeld te veel. Verkort timeout of verhoog minimale quality voor entry.",
    });
  }

  if (stopLoss && stopLoss.count >= 3 && stopLoss.winRate === 0) {
    lessons.push({
      type: "improve",
      text: "Stop-loss cluster aanwezig. Spread, OB score en entry confidence moeten strenger.",
    });
  }

  if (thesisBreak && n(thesisBreak.totalPnlPct) > 0) {
    lessons.push({
      type: "good",
      text: "Thesis-break exit werkt positief. Deze exit bewaart gemiddeld winst beter dan timeout.",
    });
  }

  const bestEq = [...byEntryQuality].sort((a, b) => b.avgPnlPct - a.avgPnlPct)[0];
  if (bestEq) {
    lessons.push({
      type: "focus",
      text: `Beste entry-quality bucket nu: ${bestEq.key}.`,
    });
  }

  const bestPs = [...byPersistence].sort((a, b) => b.avgPnlPct - a.avgPnlPct)[0];
  if (bestPs) {
    lessons.push({
      type: "focus",
      text: `Beste persistence bucket nu: ${bestPs.key}.`,
    });
  }

  const bestSpread = [...bySpread].sort((a, b) => b.avgPnlPct - a.avgPnlPct)[0];
  if (bestSpread) {
    lessons.push({
      type: "focus",
      text: `Beste spread bucket nu: ${bestSpread.key}.`,
    });
  }

  const score = Math.max(
    1,
    Math.min(
      10,
      5 + (n(summary.winRate) - 40) / 10 + n(summary.avgPnlPct) / 2
    )
  );

  return {
    score: pct(score),
    lessons,
  };
}

function enrichClosedTrades(opened, closed) {
  const openById = new Map();
  for (const ev of safeArray(opened)) {
    if (ev?.id) openById.set(ev.id, ev);
  }

  return safeArray(closed).map((ev) => {
    const open = openById.get(ev.id) || null;
    const system = ev.system || open?.system || inferSystemFromTradeId(ev.id);
    const filterSnapshot = ev.filterSnapshot || open?.filterSnapshot || null;

    return {
      id: ev.id,
      system,
      mode: ev.mode || open?.mode || "unknown",
      symbol: String(ev.symbol || open?.symbol || "").toUpperCase(),
      side: String(ev.side || open?.side || "").toUpperCase(),
      stage: String(ev.stage || open?.stage || "").toUpperCase(),
      sourceStage: String(ev.sourceStage || open?.sourceStage || "").toUpperCase(),
      reason: String(ev.reason || ev.exitReason || "unknown"),
      pnlPct: pct(ev.pnlPct),
      pnlUsd: pct(ev.pnlUsd),
      ts: n(ev.ts || ev.closedAt, 0),

      entryQuality: n(ev.entryQuality, n(open?.entryQuality, n(filterSnapshot?.entryQuality, 0))),
      persistenceScore: n(ev.persistenceScore, n(open?.persistenceScore, n(filterSnapshot?.persistenceScore, 0))),
      spreadPct: n(ev.spreadPct, n(filterSnapshot?.spreadPct, 999)),
      obScore: n(ev.obScore, n(filterSnapshot?.obScore, 0)),
      perfectCandidateScore: n(ev.perfectCandidateScore, n(filterSnapshot?.perfectCandidateScore, 0)),
      filterSnapshot,
    };
  });
}

function analyzeGroup(rows, liveConfig) {
  const summary = buildSummary(rows);

  const byReason = groupStats(rows, (x) => x.reason || "unknown", 20);
  const byStage = groupStats(rows, (x) => x.sourceStage || x.stage || "UNKNOWN", 20);
  const byEntryQuality = groupStats(rows, (x) => bucketNumber(x.entryQuality), 20);
  const byPersistence = groupStats(rows, (x) => bucketNumber(x.persistenceScore), 20);
  const bySpread = groupStats(rows, (x) => bucketSpread(x.spreadPct), 20);
  const byObScore = groupStats(rows, (x) => bucketOb(x.obScore), 20);

  const teacher = buildTeacher(
    summary,
    byReason,
    byEntryQuality,
    byPersistence,
    bySpread
  );

  return {
    summary,
    buckets: {
      byReason,
      byStage,
      byEntryQuality,
      byPersistence,
      bySpread,
      byObScore,
    },
    teacher,
    liveConfig,
  };
}

export default async function handler(req, res) {
  try {
    const { opened, closed } = await readTradeEventBook(5000);
    const rows = enrichClosedTrades(opened, closed);

    const mainBullConfig = await kv.get("main:config:snapshot:bull");
    const mainBearConfig = await kv.get("main:config:snapshot:bear");
    const moonBullConfig = await kv.get("moon:config:snapshot:bull");
    const moonBearConfig = await kv.get("moon:config:snapshot:bear");

    const moonBull = rows.filter((x) => x.system === "moon" && x.mode === "bull");
    const moonBear = rows.filter((x) => x.system === "moon" && x.mode === "bear");
    const mainBull = rows.filter((x) => x.system === "main" && x.mode === "bull");
    const mainBear = rows.filter((x) => x.system === "main" && x.mode === "bear");
    const tradeFunnel = rows.filter((x) => x.system === "moon");

    res.status(200).json({
      ok: true,
      groups: {
        moon_bull: analyzeGroup(moonBull, moonBullConfig || null),
        moon_bear: analyzeGroup(moonBear, moonBearConfig || null),
        main_bull: analyzeGroup(mainBull, mainBullConfig || null),
        main_bear: analyzeGroup(mainBear, mainBearConfig || null),
        trade_funnel: analyzeGroup(tradeFunnel, {
          bull: moonBullConfig || null,
          bear: moonBearConfig || null,
        }),
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