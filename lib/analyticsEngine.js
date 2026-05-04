// lib/analyticsEngine.js

const STAGES = ["entry", "almost", "buildup", "radar"];
const SIDES = ["bull", "bear"];

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING"
]);

let stats = null;

function createEmpty() {
  return {
    bull: createSide(),
    bear: createSide()
  };
}

function createSide() {
  return {
    entry: createStage(),
    almost: createStage(),
    buildup: createStage(),
    radar: createStage()
  };
}

function createStage() {
  return {
    total: 0,
    sums: {
      moveScore: 0,
      vm: 0,
      freshness: 0,
      pressure: 0,
      acceleration: 0
    },
    reasons: {
      lowScore: 0,
      weakFlow: 0,
      lowVolume: 0,
      badOB: 0,
      lowFreshness: 0,
      weakPressure: 0,
      negativeAcceleration: 0,
      good: 0
    }
  };
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeStage(stage) {
  return STAGES.includes(stage) ? stage : "radar";
}

function safeSide(side) {
  return side === "bear" ? "bear" : "bull";
}

function shouldSkipAnalytics(c) {
  if (!c) return true;
  if (c.uiOnly) return true;

  const source = String(c.stageSource || "").toLowerCase();

  return (
    source === "fallback" ||
    source === "ui_fallback" ||
    source === "runner_ui_fallback"
  );
}

function getRunnerPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const dir = String(c?.side || "").toLowerCase() === "bear" ? -1 : 1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const dir = String(c?.side || "").toLowerCase() === "bear" ? -1 : 1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

export function resetAnalytics() {
  stats = createEmpty();
}

export function logAnalytics(c) {
  if (!stats) return;
  if (shouldSkipAnalytics(c)) return;

  const side = safeSide(c.side);
  const stage = safeStage(c.stage);
  const s = stats?.[side]?.[stage];

  if (!s) return;

  const moveScore = safeNumber(c.moveScore, 0);
  const vm = safeNumber(c.vm, 0);
  const obScore = safeNumber(c.ob?.score, 1);
  const freshness = safeNumber(c.freshness, 0);
  const pressure = getRunnerPressure(c);
  const acceleration = getRunnerAcceleration(c);
  const flow = String(c.flow || "NEUTRAL").toUpperCase();

  s.total++;

  s.sums.moveScore += moveScore;
  s.sums.vm += vm;
  s.sums.freshness += freshness;
  s.sums.pressure += pressure;
  s.sums.acceleration += acceleration;

  if (moveScore < 62) s.reasons.lowScore++;
  if (!RUNNER_FLOWS.has(flow)) s.reasons.weakFlow++;
  if (vm < 0.025) s.reasons.lowVolume++;
  if (obScore < 0.04) s.reasons.badOB++;
  if (freshness < 6) s.reasons.lowFreshness++;
  if (pressure < 0.10) s.reasons.weakPressure++;
  if (acceleration < -0.35) s.reasons.negativeAcceleration++;

  if (
    moveScore >= 62 &&
    RUNNER_FLOWS.has(flow) &&
    vm >= 0.025 &&
    obScore >= 0.04 &&
    freshness >= 6 &&
    pressure >= 0.10 &&
    acceleration >= -0.35
  ) {
    s.reasons.good++;
  }
}

function pct(v, t) {
  return t === 0 ? "0%" : ((v / t) * 100).toFixed(1) + "%";
}

function avg(v, t) {
  return t === 0 ? 0 : Number((v / t).toFixed(4));
}

export function getAnalytics() {
  if (!stats) {
    stats = createEmpty();
  }

  const result = {};

  for (const side of SIDES) {
    result[side] = {};

    for (const stage of STAGES) {
      const s = stats[side][stage];
      const t = s.total || 0;

      result[side][stage] = {
        total: s.total,

        averages: {
          moveScore: avg(s.sums.moveScore, t),
          vm: avg(s.sums.vm, t),
          freshness: avg(s.sums.freshness, t),
          pressure: avg(s.sums.pressure, t),
          acceleration: avg(s.sums.acceleration, t)
        },

        reasons: {
          lowScore: pct(s.reasons.lowScore, t),
          weakFlow: pct(s.reasons.weakFlow, t),
          lowVolume: pct(s.reasons.lowVolume, t),
          badOB: pct(s.reasons.badOB, t),
          lowFreshness: pct(s.reasons.lowFreshness, t),
          weakPressure: pct(s.reasons.weakPressure, t),
          negativeAcceleration: pct(s.reasons.negativeAcceleration, t),
          good: pct(s.reasons.good, t)
        },

        reasonCounts: {
          lowScore: s.reasons.lowScore,
          weakFlow: s.reasons.weakFlow,
          lowVolume: s.reasons.lowVolume,
          badOB: s.reasons.badOB,
          lowFreshness: s.reasons.lowFreshness,
          weakPressure: s.reasons.weakPressure,
          negativeAcceleration: s.reasons.negativeAcceleration,
          good: s.reasons.good
        }
      };
    }
  }

  return {
    ...result,
    profile: "RUNNER",
    generatedAt: Date.now()
  };
}