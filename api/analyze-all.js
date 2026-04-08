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

function buildTopAdjustment({ summary, byReason, teacher, liveConfig }) {
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