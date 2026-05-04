// lib/executionEngine.js

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

function normalizeStage(stage) {
  return String(stage || "").toLowerCase();
}

function normalizeFlowType(flow) {
  if (!flow) return "UNKNOWN";

  if (typeof flow === "string") {
    return flow.toUpperCase();
  }

  return String(flow?.type || "UNKNOWN").toUpperCase();
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

function getRunnerPressure(c) {
  if (Number.isFinite(Number(c?.runnerPressure))) {
    return Number(c.runnerPressure);
  }

  const dir = normalizeSide(c?.side) === "bear" ? -1 : 1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(c) {
  if (Number.isFinite(Number(c?.runnerAcceleration))) {
    return Number(c.runnerAcceleration);
  }

  const dir = normalizeSide(c?.side) === "bear" ? -1 : 1;
  const ch24 = safeNumber(c?.change24, 0) * dir;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

function flowIsExhaustion(flow) {
  const type = normalizeFlowType(flow);
  return type === "EXHAUSTION" || type === "DISTRIBUTION" || type === "REVERSAL";
}

function getFlowName(c, flow) {
  const direct = normalizeFlowType(flow);
  if (direct !== "UNKNOWN") return direct;

  return String(c?.flow || "UNKNOWN").toUpperCase();
}

export function shouldEnter(c, flow, risk = {}) {
  if (!risk.allowEntry) return false;

  const stage = normalizeStage(c?.stage || c?.scannerStage);
  const flowName = getFlowName(c, flow);
  const score = safeNumber(c?.moveScore ?? c?.score, 0);
  const pressure = getRunnerPressure(c);
  const acceleration = getRunnerAcceleration(c);
  const freshness = safeNumber(c?.freshness, 0);
  const rr = safeNumber(risk?.rr ?? c?.rr, 0);
  const spreadPct = safeNumber(c?.ob?.spreadPct ?? c?.spreadPct, 0);

  const allowAlmost = Boolean(risk.allowAlmostEntry);

  if (stage !== "entry" && !(allowAlmost && stage === "almost")) return false;
  if (flowIsExhaustion(flow)) return false;
  if (!HOT_RUNNER_FLOWS.has(flowName)) return false;
  if (score < safeNumber(risk.minMoveScore, 74)) return false;
  if (freshness < safeNumber(risk.minFreshness, 6)) return false;
  if (pressure < safeNumber(risk.minPressure, 0.10)) return false;
  if (acceleration < safeNumber(risk.minAcceleration, -0.35)) return false;

  if (rr > 0 && rr < safeNumber(risk.minRR, 1.25)) return false;
  if (spreadPct > 0 && spreadPct > safeNumber(risk.maxSpreadPct, 0.14)) return false;

  return true;
}

export function shouldAdd(c, pos, risk = {}) {
  if (!pos) return false;

  const flowName = String(c?.flow || "").toUpperCase();
  const score = safeNumber(c?.moveScore ?? c?.score, 0);
  const pressure = getRunnerPressure(c);
  const acceleration = getRunnerAcceleration(c);
  const adds = safeNumber(pos?.adds, 0);
  const maxAdds = safeNumber(risk?.maxAdds, 1);
  const profitR = safeNumber(pos?.profitR ?? pos?.rMultiple, 0);

  if (!RUNNER_FLOWS.has(flowName)) return false;
  if (score < safeNumber(risk.minAddScore, 86)) return false;
  if (pressure < safeNumber(risk.minAddPressure, 0.35)) return false;
  if (acceleration < safeNumber(risk.minAddAcceleration, 0)) return false;
  if (adds >= maxAdds) return false;
  if (profitR < safeNumber(risk.minAddProfitR, 0.6)) return false;

  return true;
}

export function shouldExit(c, flow = {}) {
  const flowName = getFlowName(c, flow);
  const stage = normalizeStage(c?.stage || c?.scannerStage);
  const pressure = getRunnerPressure(c);
  const acceleration = getRunnerAcceleration(c);
  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;
  const ch1 = safeNumber(c?.change1h, 0) * dir;

  if (flowIsExhaustion(flow)) return true;
  if (flowName === "EXHAUSTION") return true;
  if (stage === "radar") return true;
  if (Boolean(c?.trailHit)) return true;
  if (Boolean(c?.invalidationHit)) return true;

  if (pressure < -0.10) return true;
  if (acceleration < -0.85) return true;
  if (Math.abs(ch1) < 0.08 && !RUNNER_FLOWS.has(String(c?.flow || "").toUpperCase())) return true;

  return false;
}

// ================= LIQUIDITY SWEEP =================
export function isLiquiditySweep(c, liquidity, side) {
  const price = safeNumber(c?.price, 0);
  const normalizedSide = normalizeSide(side || c?.side);

  if (!price) return false;

  if (normalizedSide === "bull") {
    return Boolean(
      liquidity?.support &&
      price < safeNumber(liquidity.support) * 0.995
    );
  }

  if (normalizedSide === "bear") {
    return Boolean(
      liquidity?.resistance &&
      price > safeNumber(liquidity.resistance) * 1.005
    );
  }

  return false;
}

export function isRunnerBreakout(c, liquidity = {}) {
  const price = safeNumber(c?.price, 0);
  const side = normalizeSide(c?.side);

  if (!price) return false;

  if (side === "bull") {
    return Boolean(
      liquidity?.resistance &&
      price > safeNumber(liquidity.resistance) * 1.002
    );
  }

  return Boolean(
    liquidity?.support &&
    price < safeNumber(liquidity.support) * 0.998
  );
}

export function getExecutionIntent(c, flow = {}, risk = {}) {
  if (shouldExit(c, flow)) return "EXIT";
  if (shouldAdd(c, null, risk)) return "ADD";
  if (shouldEnter(c, flow, risk)) return "ENTER";

  return "WAIT";
}