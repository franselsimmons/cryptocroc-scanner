// ... imports ...
import { THRESHOLDS } from "../../lib/_thresholds.js";
import { getAdaptiveThreshold, getAdaptivePositionSize } from "../../lib/_adaptive.js";

// ... in de handler, performance ophalen met `moon:performance`:
async function getPerformance(mode) {
  try {
    const perf = await kv.get(`moon:performance`);
    return perf || { winRate: 50, drawdown: 0 };
  } catch {
    return { winRate: 50, drawdown: 0 };
  }
}

// In buildUniverse (vergelijkbaar met main, maar met moonTh):
const moonTh = THRESHOLDS.moon;

// Adaptieve drempels
const adaptiveTiming = getAdaptiveThreshold({
  base: moonTh.timingScore,
  regime,
  performance,
  min: moonTh.timingScore - 5,
  max: moonTh.timingScore + 5,
});
const adaptiveEntryQuality = getAdaptiveThreshold({
  base: moonTh.nearEntryWatch.entryQuality,
  regime,
  performance,
  min: moonTh.nearEntryWatch.entryQuality - 5,
  max: moonTh.nearEntryWatch.entryQuality + 5,
});
const adaptiveBreakoutPressure = getAdaptiveThreshold({
  base: moonTh.nearEntryWatch.breakoutPressure,
  regime,
  performance,
  min: moonTh.nearEntryWatch.breakoutPressure - 5,
  max: moonTh.nearEntryWatch.breakoutPressure + 5,
});
const adaptiveEliteOpen = getAdaptiveThreshold({
  base: moonTh.executionScore.eliteOpen,
  regime,
  performance,
  min: moonTh.executionScore.eliteOpen - 5,
  max: moonTh.executionScore.eliteOpen + 5,
});
const adaptiveAlmostOpen = getAdaptiveThreshold({
  base: moonTh.executionScore.almostOpen,
  regime,
  performance,
  min: moonTh.executionScore.almostOpen - 5,
  max: moonTh.executionScore.almostOpen + 5,
});

// Gebruik deze in tradeCandidate, nearEntryWatch en tradeDeskStatus (zelfde structuur als main)
// ...

// Position size in de entry loop:
const positionSize = getAdaptivePositionSize({
  baseSize: BASE_POSITION_SIZE_USD,
  performance,
});