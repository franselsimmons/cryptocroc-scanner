// lib/edge.js

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING"
]);

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function getDirectionalPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const dir = String(c?.side || "").toLowerCase() === "bear" ? -1 : 1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const dir = String(c?.side || "").toLowerCase() === "bear" ? -1 : 1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

export function calculateEdge(c, regime) {
  const flow = normalizeFlow(c?.flow);
  const score = safeNumber(c?.moveScore, 0);
  const vm = safeNumber(c?.vm, 0);
  const freshness = safeNumber(c?.freshness, 0);
  const pressure = getDirectionalPressure(c);
  const acceleration = getAcceleration(c);
  const r = String(regime || "").toUpperCase();

  let edge = 0;

  if (flow === "SQUEEZE") edge += 3;
  else if (flow === "RUNNING") edge += 2.5;
  else if (flow === "BREAKOUT") edge += 1.75;
  else if (flow === "BUILDING") edge += 0.75;

  if (score >= 90) edge += 2.5;
  else if (score >= 82) edge += 2;
  else if (score >= 74) edge += 1.25;
  else if (score >= 66) edge += 0.5;

  if (vm > 0.45) edge += 1.5;
  else if (vm > 0.25) edge += 1.1;
  else if (vm > 0.10) edge += 0.6;

  if (freshness >= 20) edge += 1.25;
  else if (freshness >= 12) edge += 0.8;
  else if (freshness < 5) edge -= 1;

  if (pressure >= 1.5) edge += 1.2;
  else if (pressure >= 0.5) edge += 0.7;
  else if (pressure < 0.10) edge -= 1.2;

  if (acceleration >= 0.8) edge += 1;
  else if (acceleration >= 0.2) edge += 0.4;
  else if (acceleration < -0.35) edge -= 1.5;

  if (r === "HIGH_VOL") edge += 0.75;
  if (r === "LOW_VOL") edge -= 0.5;

  if (!RUNNER_FLOWS.has(flow)) edge -= 2;

  return Number(Math.max(0, Math.min(edge, 12)).toFixed(2));
}