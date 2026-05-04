// lib/strategy.js

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function getRunnerPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const side = String(c?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const side = String(c?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

export function chooseStrategy(c) {
  const score = safeNumber(c?.moveScore ?? c?.score, 0);
  const confluence = safeNumber(c?.confluence, 0);
  const rr = safeNumber(c?.rr, 0);
  const flow = normalizeFlow(c?.flow);
  const pressure = getRunnerPressure(c);
  const acceleration = getRunnerAcceleration(c);
  const freshness = safeNumber(c?.freshness, 0);

  if (
    flow === "SQUEEZE" &&
    score >= 82 &&
    confluence >= 72 &&
    pressure >= 0.45 &&
    acceleration >= 0
  ) {
    return "RUNNER_SQUEEZE";
  }

  if (
    flow === "RUNNING" &&
    score >= 78 &&
    rr >= 1.2 &&
    pressure >= 0.30
  ) {
    return "RUNNER_CONTINUATION";
  }

  if (
    flow === "BREAKOUT" &&
    score >= 74 &&
    freshness >= 8
  ) {
    return "RUNNER_BREAKOUT";
  }

  if (
    flow === "BUILDING" &&
    score >= 70 &&
    confluence >= 70
  ) {
    return "RUNNER_EARLY";
  }

  if (score >= 88) return "AGGRESSIVE";
  if (score >= 76) return "TREND";

  return "SAFE";
}

export function getStrategyRiskProfile(strategy) {
  const s = String(strategy || "SAFE").toUpperCase();

  if (s === "RUNNER_SQUEEZE") {
    return {
      profile: "RUNNER",
      strategy: s,
      allowEntry: true,
      allowAdd: true,
      minRR: 1.25,
      maxAdds: 1,
      trailAggression: "FAST"
    };
  }

  if (s === "RUNNER_CONTINUATION") {
    return {
      profile: "RUNNER",
      strategy: s,
      allowEntry: true,
      allowAdd: true,
      minRR: 1.20,
      maxAdds: 1,
      trailAggression: "NORMAL"
    };
  }

  if (s === "RUNNER_BREAKOUT") {
    return {
      profile: "RUNNER",
      strategy: s,
      allowEntry: true,
      allowAdd: false,
      minRR: 1.20,
      maxAdds: 0,
      trailAggression: "NORMAL"
    };
  }

  if (s === "RUNNER_EARLY") {
    return {
      profile: "RUNNER",
      strategy: s,
      allowEntry: false,
      allowAdd: false,
      minRR: 1.35,
      maxAdds: 0,
      trailAggression: "STRICT"
    };
  }

  if (s === "AGGRESSIVE") {
    return {
      profile: "RUNNER",
      strategy: s,
      allowEntry: true,
      allowAdd: false,
      minRR: 1.25,
      maxAdds: 0,
      trailAggression: "NORMAL"
    };
  }

  if (s === "TREND") {
    return {
      profile: "RUNNER",
      strategy: s,
      allowEntry: true,
      allowAdd: false,
      minRR: 1.20,
      maxAdds: 0,
      trailAggression: "NORMAL"
    };
  }

  return {
    profile: "RUNNER",
    strategy: "SAFE",
    allowEntry: false,
    allowAdd: false,
    minRR: 1.35,
    maxAdds: 0,
    trailAggression: "STRICT"
  };
}