import {
  readTradeEventBook,
  inferSystemFromTradeId,
  readManyEvents,
} from "../../lib/_analytics.js";

import * as mainBullCore from "../../lib/_core_bull.js";
import * as mainBearCore from "../../lib/_core_bear.js";
import * as moonBullCore from "../../lib/_moon_core_bull.js";
import * as moonBearCore from "../../lib/_moon_core_bear.js";

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

function up(v) {
  return String(v || "").toUpperCase();
}

function low(v) {
  return String(v || "").toLowerCase();
}

function bucketNumber(v, steps = [40, 50, 60, 70, 80]) {
  const x = n(v, 0);
  if (x < steps[0]) return `<${steps[0]}`;
  for (let i = 0; i < steps.length - 1; i++) {
    if (x >= steps[i] && x < steps[i + 1]) {
      return `${steps[i]}-${steps[i + 1] - 1}`;
    }
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

  for (const row of safeArray(rows)) {
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
  const list = safeArray(rows);
  const wins = list.filter((x) => n(x.pnlPct, 0) >= 0).length;
  const losses = list.length - wins;
  const totalPnlPct = list.reduce((a, b) => a + n(b.pnlPct, 0), 0);
  const totalPnlUsd = list.reduce((a, b) => a + n(b.pnlUsd, 0), 0);

  return {
    trades: list.length,
    wins,
    losses,
    winRate: list.length ? pct((wins / list.length) * 100) : 0,
    totalPnlPct: pct(totalPnlPct),
    totalPnlUsd: pct(totalPnlUsd),
    avgPnlPct: list.length ? pct(totalPnlPct / list.length) : 0,
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
        kind: "single_system",
        source: "live_core_cfg",
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
        kind: "single_system",
        source: "live_core_cfg",
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

function explainConfigValue(liveConfig, path, fallback = null) {
  try {
    const parts = String(path || "").split(".");
    let cur = liveConfig;
    for (const p of parts) cur = cur?.[p];
    return cur ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeReason(v) {
  const s = low(v);
  if (!s) return "unknown";
  if (s === "sl") return "stop_loss";
  if (s === "tp") return "take_profit";
  if (s === "thesis") return "thesis_break";
  return s;
}

function normalizeStageValue(...values) {
  for (const v of values) {
    const s = up(v);
    if (s && s !== "UNKNOWN" && s !== "NULL" && s !== "UNDEFINED") return s;
  }
  return "UNKNOWN";
}

function enrichClosedTrades(opened, closed) {
  const openById = new Map();

  for (const ev of safeArray(opened)) {
    if (ev?.id) openById.set(ev.id, ev);
  }

  return safeArray(closed).map((ev) => {
    const open = openById.get(ev.id) || null;
    const filterSnapshot = ev.filterSnapshot || open?.filterSnapshot || null;
    const system = ev.system || open?.system || inferSystemFromTradeId(ev.id);

    const sourceStage = normalizeStageValue(
      ev.sourceStage,
      open?.sourceStage,
      ev.scannerStageAtOpen,
      open?.scannerStageAtOpen,
      filterSnapshot?.stage
    );

    const stage = normalizeStageValue(
      ev.stage,
      open?.stage,
      ev.entryStage,
      open?.entryStage,
      sourceStage
    );

    return {
      id: ev.id,
      system,
      mode: low(ev.mode || open?.mode || "unknown"),
      symbol: up(ev.symbol || open?.symbol),
      side: up(ev.side || open?.side),
      stage,
      sourceStage,
      reason: normalizeReason(ev.reason || ev.exitReason || ev.closedReason || "unknown"),
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
      spreadPct: n(
        ev.spreadPct,
        n(open?.spreadPct, n(filterSnapshot?.spreadPct, 999))
      ),
      obScore: n(
        ev.obScore,
        n(open?.obScore, n(filterSnapshot?.obScore, 0))
      ),
      perfectCandidateScore: n(
        ev.perfectCandidateScore,
        n(open?.perfectCandidateScore, n(filterSnapshot?.perfectCandidateScore, 0))
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

function bestBucket(list, minCount = 3) {
  const arr = safeArray(list).filter((x) => n(x.count, 0) >= minCount);
  if (!arr.length) return null;

  return [...arr].sort((a, b) => {
    const pnlDiff = n(b.avgPnlPct, 0) - n(a.avgPnlPct, 0);
    if (pnlDiff !== 0) return pnlDiff;

    const wrDiff = n(b.winRate, 0) - n(a.winRate, 0);
    if (wrDiff !== 0) return wrDiff;

    return n(b.count, 0) - n(a.count, 0);
  })[0];
}

function worstBucket(list, minCount = 3) {
  const arr = safeArray(list).filter((x) => n(x.count, 0) >= minCount);
  if (!arr.length) return null;

  return [...arr].sort((a, b) => {
    const pnlDiff = n(a.avgPnlPct, 0) - n(b.avgPnlPct, 0);
    if (pnlDiff !== 0) return pnlDiff;

    const wrDiff = n(a.winRate, 0) - n(b.winRate, 0);
    if (wrDiff !== 0) return wrDiff;

    return n(b.count, 0) - n(a.count, 0);
  })[0];
}

function suggestHigherNumeric(currentValue, bucketKey) {
  const cur = n(currentValue, 0);
  const key = String(bucketKey || "");

  if (key.startsWith("<40")) return Math.max(cur, 40);
  if (key.startsWith("40-49")) return Math.max(cur, 50);
  if (key.startsWith("50-59")) return Math.max(cur, 60);
  if (key.startsWith("60-69")) return Math.max(cur, 70);
  if (key.startsWith("70-79")) return Math.max(cur, 80);

  return cur;
}

function suggestTighterSpread(currentValue, bucketKey) {
  const cur = n(currentValue, 999);
  const key = String(bucketKey || "");

  if (key === "<0.40") return Math.min(cur, 0.4);
  if (key === "0.40-0.79") return Math.min(cur, 0.8);
  if (key === "0.80-1.19") return Math.min(cur, 1.2);
  if (key === "1.20-1.59") return Math.min(cur, 1.6);

  return cur;
}

function suggestHigherOb(currentValue, bucketKey) {
  const cur = n(currentValue, 0);
  const key = String(bucketKey || "");

  if (key === "0.05+") return Math.max(cur, 0.05);
  if (key === "0-0.04") return Math.max(cur, 0);

  return cur;
}

function buildAutomaticSuggestions({
  summary,
  byReason,
  byEntryQuality,
  byPersistence,
  bySpread,
  byObScore,
  liveConfig,
}) {
  const suggestions = [];

  if (!liveConfig || liveConfig.kind !== "single_system") return suggestions;
  if (n(summary.trades, 0) < 5) return suggestions;

  const bestEq = bestBucket(byEntryQuality);
  const worstEq = worstBucket(byEntryQuality);
  const bestPs = bestBucket(byPersistence);
  const bestSpread = bestBucket(bySpread);
  const bestOb = bestBucket(byObScore);
  const stopLoss = byReason.find((x) => x.key === "stop_loss");
  const timeout = byReason.find((x) => x.key === "timeout");

  const entryMinConfidence = explainConfigValue(liveConfig, "entry.minConfidence", null);
  const almostMinConfidence = explainConfigValue(liveConfig, "almost.minConfidence", null);
  const entrySpreadMaxPct = explainConfigValue(liveConfig, "entry.spreadMaxPct", null);
  const entryObScoreMin = explainConfigValue(liveConfig, "entry.obScoreMin", null);

  if (
    bestEq &&
    worstEq &&
    entryMinConfidence != null &&
    n(bestEq.avgPnlPct, 0) > n(worstEq.avgPnlPct, 0) + 1
  ) {
    const suggested = suggestHigherNumeric(entryMinConfidence, bestEq.key);
    if (suggested > n(entryMinConfidence, 0)) {
      suggestions.push({
        path: "entry.minConfidence",
        direction: "raise",
        current: n(entryMinConfidence, 0),
        suggested,
        reason: `bucket ${bestEq.key} presteert beter dan ${worstEq.key} op entry quality`,
        basedOn: {
          bestBucket: bestEq.key,
          bestAvgPnlPct: bestEq.avgPnlPct,
          worstBucket: worstEq.key,
          worstAvgPnlPct: worstEq.avgPnlPct,
        },
      });
    }
  }

  if (
    bestEq &&
    worstEq &&
    almostMinConfidence != null &&
    n(bestEq.avgPnlPct, 0) > n(worstEq.avgPnlPct, 0) + 1
  ) {
    const suggested = suggestHigherNumeric(almostMinConfidence, bestEq.key);
    if (suggested > n(almostMinConfidence, 0)) {
      suggestions.push({
        path: "almost.minConfidence",
        direction: "raise",
        current: n(almostMinConfidence, 0),
        suggested,
        reason: `beste entry-quality zit in ${bestEq.key}; zwakkere almost setups mogen eerder afvallen`,
        basedOn: {
          bestBucket: bestEq.key,
          bestAvgPnlPct: bestEq.avgPnlPct,
        },
      });
    }
  }

  if (bestSpread && entrySpreadMaxPct != null) {
    const suggested = suggestTighterSpread(entrySpreadMaxPct, bestSpread.key);
    if (suggested < n(entrySpreadMaxPct, 999) && n(bestSpread.count, 0) >= 3) {
      suggestions.push({
        path: "entry.spreadMaxPct",
        direction: "lower",
        current: n(entrySpreadMaxPct, 0),
        suggested,
        reason: `beste spread-resultaten zitten in bucket ${bestSpread.key}`,
        basedOn: {
          bestBucket: bestSpread.key,
          bestAvgPnlPct: bestSpread.avgPnlPct,
        },
      });
    }
  }

  if (bestOb && entryObScoreMin != null) {
    const suggested = suggestHigherOb(entryObScoreMin, bestOb.key);
    if (suggested > n(entryObScoreMin, 0) && n(bestOb.count, 0) >= 3) {
      suggestions.push({
        path: "entry.obScoreMin",
        direction: "raise",
        current: n(entryObScoreMin, 0),
        suggested,
        reason: `hogere OB-score bucket ${bestOb.key} presteert beter`,
        basedOn: {
          bestBucket: bestOb.key,
          bestAvgPnlPct: bestOb.avgPnlPct,
        },
      });
    }
  }

  if (
    stopLoss &&
    n(stopLoss.count, 0) >= 3 &&
    n(stopLoss.avgPnlPct, 0) < -2 &&
    bestSpread &&
    entrySpreadMaxPct != null
  ) {
    const suggested = suggestTighterSpread(entrySpreadMaxPct, bestSpread.key);
    if (suggested < n(entrySpreadMaxPct, 999)) {
      suggestions.push({
        path: "entry.spreadMaxPct",
        direction: "lower",
        current: n(entrySpreadMaxPct, 0),
        suggested,
        reason: `stop-loss cluster is zwaar negatief en spread buckets wijzen op strakkere spread-selectie`,
        basedOn: {
          stopLossTrades: stopLoss.count,
          stopLossAvgPnlPct: stopLoss.avgPnlPct,
          bestSpreadBucket: bestSpread.key,
        },
      });
    }
  }

  if (
    timeout &&
    n(timeout.count, 0) >= 3 &&
    n(timeout.avgPnlPct, 0) < -1 &&
    bestPs &&
    almostMinConfidence != null
  ) {
    const suggested = suggestHigherNumeric(almostMinConfidence, bestPs.key);
    if (suggested > n(almostMinConfidence, 0)) {
      suggestions.push({
        path: "almost.minConfidence",
        direction: "raise",
        current: n(almostMinConfidence, 0),
        suggested,
        reason: `timeout-trades zijn te zwak en persistence-data wijst naar sterkere kwaliteit in ${bestPs.key}`,
        basedOn: {
          timeoutTrades: timeout.count,
          timeoutAvgPnlPct: timeout.avgPnlPct,
          bestPersistenceBucket: bestPs.key,
        },
      });
    }
  }

  const dedup = new Map();
  for (const s of suggestions) {
    const key = `${s.path}:${s.suggested}`;
    if (!dedup.has(key)) dedup.set(key, s);
  }

  return [...dedup.values()];
}

function buildTeacher({
  summary,
  byReason,
  byEntryQuality,
  byPersistence,
  bySpread,
  byObScore,
  liveConfig,
  dataQuality,
}) {
  const lessons = [];

  const timeout = byReason.find((x) => x.key === "timeout");
  const stopLoss = byReason.find((x) => x.key === "stop_loss");
  const thesisBreak = byReason.find((x) => x.key === "thesis_break");

  const bestEq = bestBucket(byEntryQuality);
  const worstEq = worstBucket(byEntryQuality);
  const bestPs = bestBucket(byPersistence);
  const worstPs = worstBucket(byPersistence);
  const bestSpread = bestBucket(bySpread);
  const worstSpread = worstBucket(bySpread);
  const bestOb = bestBucket(byObScore);
  const worstOb = worstBucket(byObScore);

  if (n(summary.trades, 0) < 5) {
    lessons.push({
      type: "warn",
      text: `Sample is nog klein (${summary.trades} closed trades). Zie deze inzichten als voorlopig.`,
    });
  }

  if (n(dataQuality.richCoveragePct, 0) < 60) {
    lessons.push({
      type: "warn",
      text: `Rich coverage is ${pct(dataQuality.richCoveragePct)}%. Een deel van de trades mist dus echte filterdata.`,
    });
  }

  if (n(summary.winRate) < 45 && n(summary.trades, 0) >= 5) {
    lessons.push({
      type: "improve",
      text: `Winrate is ${pct(summary.winRate)}%. Entries moeten strenger of cleaner worden gefilterd.`,
    });
  }

  if (timeout && n(timeout.avgPnlPct) < -1 && n(timeout.count, 0) >= 3) {
    lessons.push({
      type: "improve",
      text: `Timeout-trades verliezen gemiddeld ${pct(timeout.avgPnlPct)}% over ${timeout.count} trades.`,
    });
  }

  if (stopLoss && stopLoss.count >= 3 && stopLoss.winRate === 0) {
    lessons.push({
      type: "improve",
      text: `Stop-loss cluster aanwezig: ${stopLoss.count} trades, ${pct(stopLoss.totalPnlPct)}% totaal verlies.`,
    });
  }

  if (thesisBreak && n(thesisBreak.totalPnlPct, 0) > 0 && n(thesisBreak.count, 0) >= 1) {
    lessons.push({
      type: "good",
      text: `Thesis-break is positief: ${pct(thesisBreak.totalPnlPct)}% totaal bij ${thesisBreak.count} trades.`,
    });
  }

  if (bestEq) {
    lessons.push({
      type: "focus",
      text: `Beste entry-quality bucket: ${bestEq.key} (${pct(bestEq.avgPnlPct)}% avg pnl, ${pct(bestEq.winRate)}% winrate).`,
    });
  }

  if (bestPs) {
    lessons.push({
      type: "focus",
      text: `Beste persistence bucket: ${bestPs.key} (${pct(bestPs.avgPnlPct)}% avg pnl).`,
    });
  }

  if (bestSpread) {
    lessons.push({
      type: "focus",
      text: `Beste spread bucket: ${bestSpread.key} (${pct(bestSpread.avgPnlPct)}% avg pnl).`,
    });
  }

  if (bestOb) {
    lessons.push({
      type: "focus",
      text: `Beste OB-score bucket: ${bestOb.key} (${pct(bestOb.avgPnlPct)}% avg pnl).`,
    });
  }

  if (worstEq && bestEq && worstEq.key !== bestEq.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste entry-quality bucket: ${worstEq.key} (${pct(worstEq.avgPnlPct)}% avg pnl).`,
    });
  }

  if (worstPs && bestPs && worstPs.key !== bestPs.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste persistence bucket: ${worstPs.key} (${pct(worstPs.avgPnlPct)}% avg pnl).`,
    });
  }

  if (worstSpread && bestSpread && worstSpread.key !== bestSpread.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste spread bucket: ${worstSpread.key} (${pct(worstSpread.avgPnlPct)}% avg pnl).`,
    });
  }

  if (worstOb && bestOb && worstOb.key !== bestOb.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste OB-score bucket: ${worstOb.key} (${pct(worstOb.avgPnlPct)}% avg pnl).`,
    });
  }

  const autoSuggestions = buildAutomaticSuggestions({
    summary,
    byReason,
    byEntryQuality,
    byPersistence,
    bySpread,
    byObScore,
    liveConfig,
  });

  for (const s of autoSuggestions) {
    lessons.push({
      type: "action",
      text: `Concrete suggestie: pas ${s.path} aan van ${s.current} naar ongeveer ${s.suggested}. Reden: ${s.reason}.`,
    });
  }

  const score = Math.max(
    1,
    Math.min(10, 5 + (n(summary.winRate) - 40) / 10 + n(summary.avgPnlPct) / 2)
  );

  return {
    score: pct(score),
    lessons,
    suggestions: autoSuggestions,
  };
}

function suggestionPriorityScore(s) {
  if (!s) return -999;

  let score = 0;

  if (s.path === "entry.minConfidence") score += 100;
  else if (s.path === "entry.spreadMaxPct") score += 95;
  else if (s.path === "entry.obScoreMin") score += 90;
  else if (s.path === "almost.minConfidence") score += 80;
  else score += 60;

  if (s.direction === "raise" || s.direction === "lower") score += 10;

  const bestAvg = n(s?.basedOn?.bestAvgPnlPct, 0);
  const worstAvg = n(s?.basedOn?.worstAvgPnlPct, 0);
  const improvementGap = Math.max(0, bestAvg - worstAvg);
  score += improvementGap * 4;

  if (n(s?.basedOn?.stopLossTrades, 0) >= 3) score += 12;
  if (n(s?.basedOn?.timeoutTrades, 0) >= 3) score += 10;

  return score;
}

function pickTopSuggestion(suggestions = []) {
  const list = safeArray(suggestions);
  if (!list.length) return null;

  return [...list].sort((a, b) => {
    const diff = suggestionPriorityScore(b) - suggestionPriorityScore(a);
    if (diff !== 0) return diff;
    return n(b.suggested, 0) - n(a.suggested, 0);
  })[0];
}

function buildTopAdjustment({ summary, byReason, teacher }) {
  const suggestions = safeArray(teacher?.suggestions);
  const bestSuggestion = pickTopSuggestion(suggestions);

  if (bestSuggestion) {
    return {
      type: "config_change",
      priority: suggestionPriorityScore(bestSuggestion),
      title: `${bestSuggestion.path} ${bestSuggestion.direction === "raise" ? "omhoog" : "omlaag"}`,
      shortText: `Pas ${bestSuggestion.path} aan van ${bestSuggestion.current} naar ongeveer ${bestSuggestion.suggested}.`,
      longText: `Eerste aanpassing: verander ${bestSuggestion.path} van ${bestSuggestion.current} naar ongeveer ${bestSuggestion.suggested}. Reden: ${bestSuggestion.reason}.`,
      path: bestSuggestion.path,
      current: bestSuggestion.current,
      suggested: bestSuggestion.suggested,
      direction: bestSuggestion.direction,
      basedOn: bestSuggestion.basedOn || null,
    };
  }

  const stopLoss = safeArray(byReason).find((x) => x.key === "stop_loss");
  const timeout = safeArray(byReason).find((x) => x.key === "timeout");

  if (stopLoss && n(stopLoss.count, 0) >= 3 && n(stopLoss.avgPnlPct, 0) < -2) {
    return {
      type: "risk_problem",
      priority: 70,
      title: "Stop-loss cluster aanpakken",
      shortText: `Stop-loss trades zijn nu het grootste probleem (${stopLoss.count} trades, gem. ${stopLoss.avgPnlPct}%).`,
      longText: `Eerste focus: stop-loss cluster aanpakken. Deze trades verliezen gemiddeld ${stopLoss.avgPnlPct}% over ${stopLoss.count} trades.`,
    };
  }

  if (timeout && n(timeout.count, 0) >= 3 && n(timeout.avgPnlPct, 0) < -1) {
    return {
      type: "timeout_problem",
      priority: 65,
      title: "Timeout kwaliteit verhogen",
      shortText: `Timeout trades zijn te zwak (${timeout.count} trades, gem. ${timeout.avgPnlPct}%).`,
      longText: `Eerste focus: timeout trades verbeteren. Deze verliezen gemiddeld ${timeout.avgPnlPct}% over ${timeout.count} trades.`,
    };
  }

  if (n(summary?.trades, 0) < 5) {
    return {
      type: "sample_small",
      priority: 20,
      title: "Meer sample nodig",
      shortText: `Nog maar ${summary?.trades || 0} closed trades.`,
      longText: `Nog geen harde aanpassing: sample is te klein met ${summary?.trades || 0} closed trades.`,
    };
  }

  return {
    type: "monitor",
    priority: 10,
    title: "Nog geen harde wijziging",
    shortText: "Nog geen duidelijke config-wijziging met hoge zekerheid.",
    longText: "Nog geen duidelijke eerste wijziging gevonden. Monitor meer trades of rich data.",
  };
}

function buildTopSummary(groupKey, group) {
  const summary = group?.summary || {};
  const topAdjustment = group?.topAdjustment || null;

  return {
    groupKey,
    score: n(group?.teacher?.score, 0),
    winRate: n(summary.winRate, 0),
    trades: n(summary.trades, 0),
    avgPnlPct: n(summary.avgPnlPct, 0),
    totalPnlUsd: n(summary.totalPnlUsd, 0),
    topAdjustment,
  };
}

function stageRank(stage) {
  const s = up(stage);
  if (s === "RADAR") return 1;
  if (s === "BUILDUP") return 2;
  if (s === "ALMOST") return 3;
  if (s === "TRADE_READY") return 4;
  if (s === "ELITE_IGNITION") return 4;
  if (s === "ELITE_EXPANSION") return 5;
  if (s === "ELITE_CASCADE") return 5;
  return 0;
}

function isStrongLaterState(row) {
  if (!row) return false;
  if (stageRank(row.to || row.stage) >= 4) return true;
  if (n(row.perfectCandidateScore, 0) >= 70) return true;
  if (n(row.entryQuality, 0) >= 50) return true;
  return false;
}

function analyzeStuckCoins(scanStates, transitions, system, mode) {
  const states = safeArray(scanStates).filter(
    (x) => x.system === system && x.mode === mode
  );
  const moves = safeArray(transitions).filter(
    (x) => x.system === system && x.mode === mode
  );

  const laterStrongBySymbol = new Map();

  for (const row of moves) {
    const sym = up(row.symbol);
    if (!sym) continue;
    if (isStrongLaterState(row)) laterStrongBySymbol.set(sym, true);
  }

  for (const row of states) {
    const sym = up(row.symbol);
    if (!sym) continue;
    if (isStrongLaterState(row)) laterStrongBySymbol.set(sym, true);
  }

  const relevantStages = ["RADAR", "BUILDUP", "ALMOST"];
  const out = [];

  for (const st of relevantStages) {
    const rows = states.filter((x) => up(x.stage) === st);
    const uniqueSymbols = [...new Set(rows.map((x) => up(x.symbol)).filter(Boolean))];

    let laterStrong = 0;
    for (const sym of uniqueSymbols) {
      if (laterStrongBySymbol.get(sym)) laterStrong += 1;
    }

    out.push({
      stage: st,
      seenCoins: uniqueSymbols.length,
      laterStrongCoins: laterStrong,
      stuckButLaterStrongRate: uniqueSymbols.length
        ? pct((laterStrong / uniqueSymbols.length) * 100)
        : 0,
    });
  }

  return out.sort((a, b) => b.stuckButLaterStrongRate - a.stuckButLaterStrongRate);
}

function buildFunnelBlockersTeacher(stuckStats) {
  const lessons = [];
  const top = safeArray(stuckStats)[0];

  if (top && n(top.laterStrongCoins, 0) >= 3) {
    lessons.push({
      type: "blocker",
      text: `${top.stage} houdt relatief veel coins vast die later sterk blijken (${pct(top.stuckButLaterStrongRate)}%).`,
    });
  }

  for (const row of safeArray(stuckStats)) {
    if (n(row.stuckButLaterStrongRate, 0) >= 25 && n(row.laterStrongCoins, 0) >= 3) {
      lessons.push({
        type: "focus",
        text: `${row.stage}: ${row.laterStrongCoins} coins werden later sterk na hier vast te zitten (${pct(row.stuckButLaterStrongRate)}%).`,
      });
    }
  }

  return lessons;
}

function analyzeGroup(rows, liveConfig) {
  const allRows = safeArray(rows);
  const richRows = allRows.filter(isRichTrade);
  const summary = buildSummary(allRows);

  const useRichRows = richRows.length >= 5;
  const analysisRows = useRichRows ? richRows : allRows;

  const dataQuality = {
    totalClosedTrades: allRows.length,
    richClosedTrades: richRows.length,
    richCoveragePct: allRows.length ? pct((richRows.length / allRows.length) * 100) : 0,
    usingRichRows: useRichRows,
  };

  const byReason = groupStats(allRows, (x) => x.reason || "unknown", 20);
  const byStage = groupStats(allRows, (x) => x.sourceStage || x.stage || "UNKNOWN", 20);
  const byEntryQuality = groupStats(analysisRows, (x) => bucketNumber(x.entryQuality), 20);
  const byPersistence = groupStats(analysisRows, (x) => bucketNumber(x.persistenceScore), 20);
  const bySpread = groupStats(analysisRows, (x) => bucketSpread(x.spreadPct), 20);
  const byObScore = groupStats(analysisRows, (x) => bucketOb(x.obScore), 20);

  const teacher = buildTeacher({
    summary,
    byReason,
    byEntryQuality,
    byPersistence,
    bySpread,
    byObScore,
    liveConfig,
    dataQuality,
  });

  const group = {
    summary,
    dataQuality,
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

  group.topAdjustment = buildTopAdjustment({
    summary,
    byReason,
    teacher,
  });

  return group;
}

export default async function handler(req, res) {
  try {
    const { opened, closed } = await readTradeEventBook(5000);
    const extra = await readManyEvents(["scan_transition", "scan_coin_state"], 10000);

    const scanTransitions = extra.scan_transition || [];
    const scanCoinStates = extra.scan_coin_state || [];

    const rows = enrichClosedTrades(opened, closed);

    const liveConfig = {
      moon_bull: pickLiveConfig(moonBullCore, "moon"),
      moon_bear: pickLiveConfig(moonBearCore, "moon"),
      main_bull: pickLiveConfig(mainBullCore, "main"),
      main_bear: pickLiveConfig(mainBearCore, "main"),
      trade_funnel: {
        kind: "aggregate",
        note: "Trade Funnel is een samengestelde groep van meerdere systemen en modes. Daarom bestaat hier geen enkele live config.",
      },
    };

    const moonBull = rows.filter((x) => x.system === "moon" && x.mode === "bull");
    const moonBear = rows.filter((x) => x.system === "moon" && x.mode === "bear");
    const mainBull = rows.filter((x) => x.system === "main" && x.mode === "bull");
    const mainBear = rows.filter((x) => x.system === "main" && x.mode === "bear");
    const tradeFunnel = rows;

    const moonBullStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "moon", "bull");
    const moonBearStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "moon", "bear");
    const mainBullStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "main", "bull");
    const mainBearStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "main", "bear");

    const groups = {
      moon_bull: {
        ...analyzeGroup(moonBull, liveConfig.moon_bull),
        funnelBlockers: {
          stuckStats: moonBullStuck,
          lessons: buildFunnelBlockersTeacher(moonBullStuck),
        },
      },
      moon_bear: {
        ...analyzeGroup(moonBear, liveConfig.moon_bear),
        funnelBlockers: {
          stuckStats: moonBearStuck,
          lessons: buildFunnelBlockersTeacher(moonBearStuck),
        },
      },
      main_bull: {
        ...analyzeGroup(mainBull, liveConfig.main_bull),
        funnelBlockers: {
          stuckStats: mainBullStuck,
          lessons: buildFunnelBlockersTeacher(mainBullStuck),
        },
      },
      main_bear: {
        ...analyzeGroup(mainBear, liveConfig.main_bear),
        funnelBlockers: {
          stuckStats: mainBearStuck,
          lessons: buildFunnelBlockersTeacher(mainBearStuck),
        },
      },
      trade_funnel: {
        ...analyzeGroup(tradeFunnel, liveConfig.trade_funnel),
        funnelBlockers: {
          stuckStats: [
            ...moonBullStuck.map((x) => ({ group: "moon_bull", ...x })),
            ...moonBearStuck.map((x) => ({ group: "moon_bear", ...x })),
            ...mainBullStuck.map((x) => ({ group: "main_bull", ...x })),
            ...mainBearStuck.map((x) => ({ group: "main_bear", ...x })),
          ].sort((a, b) => b.stuckButLaterStrongRate - a.stuckButLaterStrongRate),
          lessons: [
            ...buildFunnelBlockersTeacher(moonBullStuck),
            ...buildFunnelBlockersTeacher(moonBearStuck),
            ...buildFunnelBlockersTeacher(mainBullStuck),
            ...buildFunnelBlockersTeacher(mainBearStuck),
          ],
        },
      },
    };

    const overview = {
      trade_funnel: buildTopSummary("trade_funnel", groups.trade_funnel),
      moon_bull: buildTopSummary("moon_bull", groups.moon_bull),
      moon_bear: buildTopSummary("moon_bear", groups.moon_bear),
      main_bull: buildTopSummary("main_bull", groups.main_bull),
      main_bear: buildTopSummary("main_bear", groups.main_bear),
    };

    return res.status(200).json({
      ok: true,
      overview,
      groups,
      ts: Date.now(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}