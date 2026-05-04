import { multiTFScore } from "./timeframe.js";
import { getFilters } from "./filterState.js";

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING"
]);

const HOT_RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT"
]);

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function flowAllowed(flow, allowNeutral = false, requireHot = false) {
  const normalized = normalizeFlow(flow);

  if (requireHot) return HOT_RUNNER_FLOWS.has(normalized);
  if (allowNeutral) return true;

  return RUNNER_FLOWS.has(normalized);
}

function getTfScore(c) {
  const cached = Number(c?.tfScore);

  if (Number.isFinite(cached)) {
    return cached;
  }

  return Number(multiTFScore(c) || 0);
}

function getRunnerPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const ch24 = safeNumber(c?.change24, 0);
  const ch1 = safeNumber(c?.change1h, 0);

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const ch24 = safeNumber(c?.change24, 0);
  const ch1 = safeNumber(c?.change1h, 0);

  return ch1 - (ch24 / 24);
}

function passesCommonRunnerGate(c, f, options = {}) {
  const score = safeNumber(c?.moveScore, 0);
  const vm = safeNumber(c?.vm, 0);
  const freshness = safeNumber(c?.freshness, 0);
  const pressure = getRunnerPressure(c);
  const acceleration = getRunnerAcceleration(c);

  const minScore = safeNumber(f?.scoreMin, 0);
  const minVolume = safeNumber(f?.volumeMin, 0);
  const minFreshness = safeNumber(f?.freshnessMin, options.minFreshness ?? 0);
  const minPressure = safeNumber(f?.pressureMin, options.minPressure ?? 0);
  const minAcceleration = safeNumber(f?.accelerationMin, options.minAcceleration ?? -999);

  if (score < minScore) return false;
  if (vm < minVolume) return false;
  if (freshness < minFreshness) return false;
  if (pressure < minPressure) return false;
  if (acceleration < minAcceleration) return false;

  return flowAllowed(c?.flow, Boolean(f?.allowNeutral), Boolean(options.requireHotFlow));
}

export function bullFilter(c) {
  const tf = getTfScore(c);
  const f = getFilters().bull || {};

  const entry = f.entry || {};
  const almost = f.almost || {};
  const buildup = f.buildup || {};
  const radar = f.radar || {};

  if (
    tf >= safeNumber(entry.tfMin, 0) &&
    passesCommonRunnerGate(c, entry, {
      requireHotFlow: true,
      minFreshness: 10,
      minPressure: 0.12,
      minAcceleration: -0.25
    })
  ) {
    return "entry";
  }

  if (
    tf >= safeNumber(almost.tfMin, 0) &&
    passesCommonRunnerGate(c, almost, {
      requireHotFlow: false,
      minFreshness: 7,
      minPressure: 0.08,
      minAcceleration: -0.35
    })
  ) {
    return "almost";
  }

  if (
    tf >= safeNumber(buildup.tfMin, 0) &&
    passesCommonRunnerGate(c, buildup, {
      requireHotFlow: false,
      minFreshness: 4,
      minPressure: 0.04,
      minAcceleration: -0.55
    })
  ) {
    return "buildup";
  }

  if (
    passesCommonRunnerGate(c, radar, {
      requireHotFlow: false,
      minFreshness: 0,
      minPressure: 0,
      minAcceleration: -0.80
    })
  ) {
    return "radar";
  }

  return false;
}