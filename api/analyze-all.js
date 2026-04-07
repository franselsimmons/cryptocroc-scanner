import { kv } from "@vercel/kv";
import { readTradeEventBook, inferSystemFromTradeId } from "../lib/_analytics.js";

// Namespace imports voor core bestanden
import * as mainBullCore from "../lib/_core_bull.js";
import * as mainBearCore from "../lib/_core_bear.js";
import * as moonBullCore from "../lib/_moon_core_bull.js";
import * as moonBearCore from "../lib/_moon_core_bear.js";

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

  const worstEq = [...byEntryQuality].sort((a, b) => a.avgPnlPct - b.avgPnlPct)[0];
  const worstPs = [...byPersistence].sort((a, b) => a.avgPnlPct - b.avgPnlPct)[0];
  const worstSpread = [...bySpread].sort((a, b) => a.avgPnlPct - b.avgPnlPct)[0];

  if (worstEq && worstEq.key !== bestEq?.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste entry-quality bucket nu: ${worstEq.key}. Deze bucket moet strenger of uitgesloten worden.`,
    });
  }

  if (worstPs && worstPs.key !== bestPs?.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste persistence bucket nu: ${worstPs.key}. Hier lekt waarschijnlijk kwaliteit weg.`,
    });
  }

  if (worstSpread && worstSpread.key !== bestSpread?.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste spread bucket nu: ${worstSpread.key}. Deze spread-range kost waarschijnlijk rendement.`,
    });
  }

  const score = Math.max(
    1,
    Math.min(10, 5 + (n(summary.winRate) - 40) / 10 + n(summary.avgPnlPct) / 2)
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

      entryQuality: n(
        ev.entryQuality,
        n(open?.entryQuality, n(filterSnapshot?.entryQuality, 0))
      ),
      persistenceScore: n(
        ev.persistenceScore,
        n(open?.persistenceScore, n(filterSnapshot?.persistenceScore, 0))
      ),
      spreadPct: n(ev.spreadPct, n(filterSnapshot?.spreadPct, 999)),
      obScore: n(ev.obScore, n(filterSnapshot?.obScore, 0)),
      perfectCandidateScore: n(
        ev.perfectCandidateScore,
        n(filterSnapshot?.perfectCandidateScore, 0)
      ),
      filterSnapshot,
    };
  });
}

function isRichTrade(row) {
  if (!row) return false;

  if (row.filterSnapshot) return true;
  if (n(row.entryQuality, 0) > 0) return true;
  if (n(row.persistenceScore, 0) > 0) return true;
  if (n(row.spreadPct, 999) < 900) return true;
  if (Math.abs(n(row.obScore, 0)) > 0) return true;

  return false;
}

function analyzeGroup(rows, liveConfig) {
  const allRows = safeArray(rows);
  const richRows = allRows.filter(isRichTrade);

  const summary = buildSummary(allRows);

  const analysisRows = richRows.length ? richRows : allRows;

  const byReason = groupStats(allRows, (x) => x.reason || "unknown", 20);
  const byStage = groupStats(allRows, (x) => x.sourceStage || x.stage || "UNKNOWN", 20);
  const byEntryQuality = groupStats(analysisRows, (x) => bucketNumber(x.entryQuality), 20);
  const byPersistence = groupStats(analysisRows, (x) => bucketNumber(x.persistenceScore), 20);
  const bySpread = groupStats(analysisRows, (x) => bucketSpread(x.spreadPct), 20);
  const byObScore = groupStats(analysisRows, (x) => bucketOb(x.obScore), 20);

  const teacher = buildTeacher(
    summary,
    byReason,
    byEntryQuality,
    byPersistence,
    bySpread
  );

  return {
    summary,
    dataQuality: {
      totalClosedTrades: allRows.length,
      richClosedTrades: richRows.length,
      richCoveragePct: allRows.length ? pct((richRows.length / allRows.length) * 100) : 0,
    },
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

function resolveCfg(core) {
  if (typeof core?.getCfg === "function") return core.getCfg();
  if (typeof core?.default?.getCfg === "function") return core.default.getCfg();
  return {};
}

function pickLiveConfig(core, type) {
  try {
    const cfg = resolveCfg(core);

    if (type === "main") {
      return {
        radar: cfg?.radar || null,
        buildup: cfg?.buildup || null,
        almost: cfg?.almost || null,
        entry: cfg?.entry || null,
        limits: {
          ENTRY_LIMIT: cfg?.ENTRY_LIMIT ?? null,
          ALMOST_LIMIT: cfg?.ALMOST_LIMIT ?? null,
          BUILDUP_LIMIT: cfg?.BUILDUP_LIMIT ?? null,
          RADAR_LIMIT: cfg?.RADAR_LIMIT ?? null,
          CG_TOP: cfg?.CG_TOP ?? null,
        },
      };
    }

    if (type === "moon") {
      return {
        radar: cfg?.radar || null,
        buildup: cfg?.buildup || null,
        almost: cfg?.almost || null,
        elite: cfg?.elite || null,
        entry: cfg?.entry || null,
        desk: cfg?.desk || null,
        exits: cfg?.exits || null,
        limits: {
          ENTRY_LIMIT: cfg?.ENTRY_LIMIT ?? null,
          ALMOST_LIMIT: cfg?.ALMOST_LIMIT ?? null,
          BUILDUP_LIMIT: cfg?.BUILDUP_LIMIT ?? null,
          RADAR_LIMIT: cfg?.RADAR_LIMIT ?? null,
          CG_TOP: cfg?.CG_TOP ?? null,
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const { opened, closed } = await readTradeEventBook(5000);
    const rows = enrichClosedTrades(opened, closed);

    const liveConfig = {
      main_bull: pickLiveConfig(mainBullCore, "main"),
      main_bear: pickLiveConfig(mainBearCore, "main"),
      moon_bull: pickLiveConfig(moonBullCore, "moon"),
      moon_bear: pickLiveConfig(moonBearCore, "moon"),
    };

    const moonBull = rows.filter((x) => x.system === "moon" && x.mode === "bull");
    const moonBear = rows.filter((x) => x.system === "moon" && x.mode === "bear");
    const mainBull = rows.filter((x) => x.system === "main" && x.mode === "bull");
    const mainBear = rows.filter((x) => x.system === "main" && x.mode === "bear");
    const tradeFunnel = rows;

    res.status(200).json({
      ok: true,
      groups: {
        moon_bull: analyzeGroup(moonBull, liveConfig.moon_bull),
        moon_bear: analyzeGroup(moonBear, liveConfig.moon_bear),
        main_bull: analyzeGroup(mainBull, liveConfig.main_bull),
        main_bear: analyzeGroup(mainBear, liveConfig.main_bear),
        trade_funnel: analyzeGroup(tradeFunnel, {
          main_bull: liveConfig.main_bull,
          main_bear: liveConfig.main_bear,
          moon_bull: liveConfig.moon_bull,
          moon_bear: liveConfig.moon_bear,
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