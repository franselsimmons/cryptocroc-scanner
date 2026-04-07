import { readTradeEventBook, inferSystemFromTradeId, readManyEvents } from "../lib/_analytics.js";

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

function fmtBucketTeacher(bucket) {
  if (!bucket) return "-";
  return `${pct(bucket.avgPnlPct)}% avg pnl en ${pct(bucket.winRate)}% winrate over ${n(bucket.count, 0)} trades`;
}

function bestBucket(list) {
  const arr = safeArray(list).filter((x) => n(x.count, 0) >= 3);
  if (!arr.length) return null;

  return [...arr].sort((a, b) => {
    const pnlDiff = n(b.avgPnlPct, 0) - n(a.avgPnlPct, 0);
    if (pnlDiff !== 0) return pnlDiff;

    const wrDiff = n(b.winRate, 0) - n(a.winRate, 0);
    if (wrDiff !== 0) return wrDiff;

    return n(b.count, 0) - n(a.count, 0);
  })[0];
}

function worstBucket(list) {
  const arr = safeArray(list).filter((x) => n(x.count, 0) >= 3);
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
  if (key.endsWith("+")) return cur;

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

function buildTeacher(summary, byReason, byEntryQuality, byPersistence, bySpread, byObScore, liveConfig) {
  const lessons = [];

  const timeout = byReason.find((x) => x.key === "timeout");
  const stopLoss = byReason.find((x) => x.key === "sl" || x.key === "stop_loss");
  const thesisBreak = byReason.find((x) => x.key === "thesis_break");

  const bestEq = bestBucket(byEntryQuality);
  const worstEq = worstBucket(byEntryQuality);

  const bestPs = bestBucket(byPersistence);
  const worstPs = worstBucket(byPersistence);

  const bestSpread = bestBucket(bySpread);
  const worstSpread = worstBucket(bySpread);

  const bestOb = bestBucket(byObScore);
  const worstOb = worstBucket(byObScore);

  const liveEntryMinConfidence = explainConfigValue(liveConfig, "entry.minConfidence", null);
  const liveSpreadMaxPct = explainConfigValue(liveConfig, "entry.spreadMaxPct", null);
  const liveObScoreMin = explainConfigValue(liveConfig, "entry.obScoreMin", null);
  const liveAlmostMinConfidence = explainConfigValue(liveConfig, "almost.minConfidence", null);

  if (n(summary.winRate) < 45) {
    lessons.push({
      type: "improve",
      text: `Winrate is ${pct(summary.winRate)}%. Dat is te laag. Entries moeten strenger worden op basis van best presterende buckets.`,
    });
  }

  if (timeout && n(timeout.avgPnlPct) < -1) {
    lessons.push({
      type: "improve",
      text: `Timeout trades verliezen gemiddeld ${pct(timeout.avgPnlPct)}%. Timeout is nu te duur en moet strenger of korter.`,
    });
  }

  if (stopLoss && stopLoss.count >= 3 && stopLoss.winRate === 0) {
    lessons.push({
      type: "improve",
      text: `Stop-loss cluster aanwezig: ${stopLoss.count} trades, ${pct(stopLoss.totalPnlPct)}% totaal. Entryfilters zijn nog te los.`,
    });
  }

  if (thesisBreak && n(thesisBreak.totalPnlPct) > 0) {
    lessons.push({
      type: "good",
      text: `Thesis-break is positief: ${pct(thesisBreak.totalPnlPct)}% totaal bij ${thesisBreak.count} trades.`,
    });
  }

  if (bestEq) {
    lessons.push({
      type: "focus",
      text: `Beste entry-quality bucket: ${bestEq.key} met ${fmtBucketTeacher(bestEq)}.`,
    });
  }

  if (bestPs) {
    lessons.push({
      type: "focus",
      text: `Beste persistence bucket: ${bestPs.key} met ${fmtBucketTeacher(bestPs)}.`,
    });
  }

  if (bestSpread) {
    lessons.push({
      type: "focus",
      text: `Beste spread bucket: ${bestSpread.key} met ${fmtBucketTeacher(bestSpread)}.`,
    });
  }

  if (bestOb) {
    lessons.push({
      type: "focus",
      text: `Beste OB-score bucket: ${bestOb.key} met ${fmtBucketTeacher(bestOb)}.`,
    });
  }

  if (worstEq && bestEq && worstEq.key !== bestEq.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste entry-quality bucket: ${worstEq.key} met ${fmtBucketTeacher(worstEq)}.`,
    });
  }

  if (worstPs && bestPs && worstPs.key !== bestPs.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste persistence bucket: ${worstPs.key} met ${fmtBucketTeacher(worstPs)}.`,
    });
  }

  if (worstSpread && bestSpread && worstSpread.key !== bestSpread.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste spread bucket: ${worstSpread.key} met ${fmtBucketTeacher(worstSpread)}.`,
    });
  }

  if (worstOb && bestOb && worstOb.key !== bestOb.key) {
    lessons.push({
      type: "warn",
      text: `Slechtste OB-score bucket: ${worstOb.key} met ${fmtBucketTeacher(worstOb)}.`,
    });
  }

  if (bestEq && liveEntryMinConfidence != null) {
    const suggested = suggestHigherNumeric(liveEntryMinConfidence, bestEq.key);
    if (suggested > n(liveEntryMinConfidence, 0)) {
      lessons.push({
        type: "action",
        text: `Concrete suggestie: verhoog entry.minConfidence van ${liveEntryMinConfidence} naar ongeveer ${suggested}, omdat bucket ${bestEq.key} beter presteert.`,
      });
    }
  }

  if (bestEq && liveAlmostMinConfidence != null) {
    const suggestedAlmost = suggestHigherNumeric(liveAlmostMinConfidence, bestEq.key);
    if (suggestedAlmost > n(liveAlmostMinConfidence, 0)) {
      lessons.push({
        type: "action",
        text: `Concrete suggestie: verhoog almost.minConfidence van ${liveAlmostMinConfidence} naar ongeveer ${suggestedAlmost}, zodat zwakkere pre-entry setups eerder afvallen.`,
      });
    }
  }

  if (bestSpread && liveSpreadMaxPct != null) {
    const suggestedSpread = suggestTighterSpread(liveSpreadMaxPct, bestSpread.key);
    if (suggestedSpread < n(liveSpreadMaxPct, 999)) {
      lessons.push({
        type: "action",
        text: `Concrete suggestie: verlaag entry.spreadMaxPct van ${liveSpreadMaxPct} naar ongeveer ${suggestedSpread}, omdat de beste resultaten in bucket ${bestSpread.key} zitten.`,
      });
    }
  }

  if (bestOb && liveObScoreMin != null) {
    const obKey = String(bestOb.key || "");
    let suggestedOb = n(liveObScoreMin, 0);

    if (obKey === "0.05+") suggestedOb = Math.max(suggestedOb, 0.05);
    else if (obKey === "0-0.04") suggestedOb = Math.max(suggestedOb, 0);

    if (suggestedOb > n(liveObScoreMin, 0)) {
      lessons.push({
        type: "action",
        text: `Concrete suggestie: verhoog entry.obScoreMin van ${liveObScoreMin} naar ongeveer ${suggestedOb}, omdat hogere OB buckets beter presteren.`,
      });
    }
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
        n(
          open?.perfectCandidateScore,
          n(filterSnapshot?.perfectCandidateScore, 0)
        )
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
  const analysisRows = richRows.length >= 5 ? richRows : allRows;

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
    bySpread,
    byObScore,
    liveConfig
  );

  return {
    summary,
    dataQuality: {
      totalClosedTrades: allRows.length,
      richClosedTrades: richRows.length,
      richCoveragePct: allRows.length ? pct((richRows.length / allRows.length) * 100) : 0,
      usingRichRows: richRows.length >= 5,
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

// ========== STUCK‑COIN ANALYSE (nieuw) ==========
function stageRank(stage) {
  const s = String(stage || "").toUpperCase();
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
    const sym = String(row.symbol || "").toUpperCase();
    if (!sym) continue;
    if (isStrongLaterState(row)) laterStrongBySymbol.set(sym, true);
  }

  for (const row of states) {
    const sym = String(row.symbol || "").toUpperCase();
    if (!sym) continue;
    if (isStrongLaterState(row)) laterStrongBySymbol.set(sym, true);
  }

  const relevantStages = ["RADAR", "BUILDUP", "ALMOST"];
  const out = [];

  for (const st of relevantStages) {
    const rows = states.filter((x) => String(x.stage || "").toUpperCase() === st);
    const uniqueSymbols = [...new Set(rows.map((x) => String(x.symbol || "").toUpperCase()).filter(Boolean))];

    let laterStrong = 0;
    for (const sym of uniqueSymbols) {
      if (laterStrongBySymbol.get(sym)) laterStrong += 1;
    }

    const stuckRate = uniqueSymbols.length ? pct((laterStrong / uniqueSymbols.length) * 100) : 0;

    out.push({
      stage: st,
      seenCoins: uniqueSymbols.length,
      laterStrongCoins: laterStrong,
      stuckButLaterStrongRate: stuckRate,
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
      text: `${top.stage} houdt relatief veel coins vast die later sterk blijken. Dit filtercluster is waarschijnlijk te streng of te vroeg.`,
    });
  }

  for (const row of safeArray(stuckStats)) {
    if (n(row.stuckButLaterStrongRate, 0) >= 25 && n(row.laterStrongCoins, 0) >= 3) {
      lessons.push({
        type: "focus",
        text: `${row.stage}: ${row.laterStrongCoins} coins werden later sterk na hier vast te zitten (${row.stuckButLaterStrongRate}%).`,
      });
    }
  }

  return lessons;
}

// ========== MAIN HANDLER ==========
export default async function handler(req, res) {
  try {
    const { opened, closed } = await readTradeEventBook(5000);
    const extra = await readManyEvents(["scan_transition", "scan_coin_state"], 10000);
    const scanTransitions = extra.scan_transition || [];
    const scanCoinStates = extra.scan_coin_state || [];

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

    // stuck analyses
    const moonBullStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "moon", "bull");
    const moonBearStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "moon", "bear");
    const mainBullStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "main", "bull");
    const mainBearStuck = analyzeStuckCoins(scanCoinStates, scanTransitions, "main", "bear");

    res.status(200).json({
      ok: true,
      groups: {
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
          ...analyzeGroup(tradeFunnel, {
            main_bull: liveConfig.main_bull,
            main_bear: liveConfig.main_bear,
            moon_bull: liveConfig.moon_bull,
            moon_bear: liveConfig.moon_bear,
          }),
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