import { getPerformance } from "./performance.js";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function getAdaptiveSettings() {
  const perf = getPerformance();

  const winrate = safeNumber(perf?.winrate, 50);
  const totalTrades = safeNumber(perf?.total, 0);

  let rrMin = 1.35;
  let scoreMin = 72;
  let confluenceMin = 68;
  let allowAlmostEntry = false;
  let trailStartR = 1.6;
  let maxAdds = 1;

  if (totalTrades < 20) {
    return {
      profile: "RUNNER",
      rrMin,
      scoreMin,
      confluenceMin,
      allowAlmostEntry,
      trailStartR,
      maxAdds,
      winrate,
      totalTrades,
      mode: "BOOTSTRAP"
    };
  }

  if (winrate < 45) {
    rrMin = 1.65;
    scoreMin = 80;
    confluenceMin = 76;
    allowAlmostEntry = false;
    trailStartR = 1.25;
    maxAdds = 0;
  }

  if (winrate >= 45 && winrate < 55) {
    rrMin = 1.45;
    scoreMin = 76;
    confluenceMin = 72;
    allowAlmostEntry = false;
    trailStartR = 1.45;
    maxAdds = 1;
  }

  if (winrate >= 55 && winrate <= 65) {
    rrMin = 1.30;
    scoreMin = 72;
    confluenceMin = 68;
    allowAlmostEntry = false;
    trailStartR = 1.60;
    maxAdds = 1;
  }

  if (winrate > 65) {
    rrMin = 1.20;
    scoreMin = 68;
    confluenceMin = 64;
    allowAlmostEntry = true;
    trailStartR = 1.80;
    maxAdds = 1;
  }

  return {
    profile: "RUNNER",
    rrMin,
    scoreMin,
    confluenceMin,
    allowAlmostEntry,
    trailStartR,
    maxAdds,
    winrate,
    totalTrades,
    mode: winrate > 65 ? "EXPAND" : winrate < 45 ? "DEFENSIVE" : "NORMAL"
  };
}