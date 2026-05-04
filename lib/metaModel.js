// lib/metaModel.js

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v)));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

function normalizeStage(stage) {
  const s = String(stage || "").toLowerCase();

  if (s === "entry" || s === "candidate" || s === "hot") return "ENTRY";
  if (s === "almost") return "ALMOST";
  if (s === "buildup") return "BUILDUP";
  if (s === "radar") return "RADAR";

  return "UNKNOWN";
}

function getRunnerPressure(input) {
  if (Number.isFinite(Number(input?.runnerPressure))) {
    return Number(input.runnerPressure);
  }

  const side = String(input?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(input?.change24, 0) * dir;
  const ch1 = safeNumber(input?.change1h, 0) * dir;

  return (ch1 * 0.78) + (ch24 * 0.22);
}

function getRunnerAcceleration(input) {
  if (Number.isFinite(Number(input?.runnerAcceleration))) {
    return Number(input.runnerAcceleration);
  }

  const side = String(input?.side || "").toLowerCase();
  const dir = side === "bear" ? -1 : 1;

  const ch24 = safeNumber(input?.change24, 0) * dir;
  const ch1 = safeNumber(input?.change1h, 0) * dir;

  return ch1 - (ch24 / 24);
}

// ================= FEATURE VECTOR =================
function extractMetaVector(input = {}) {
  const flowName = normalizeFlow(input.flow);
  const stageName = normalizeStage(input.stage || input.scannerStage);

  const moveScore = clamp(safeNumber(input.moveScore ?? input.score, 0) / 100, 0, 1.15);
  const confluence = clamp(safeNumber(input.confluence, 0) / 100, 0, 1.15);
  const rr = clamp(safeNumber(input.rr, 0) / 2.5, 0, 1.4);
  const vm = clamp(safeNumber(input.vm, 0) * 3.2, 0, 2);
  const edge = clamp(safeNumber(input.edge, 0) / 8, 0, 1.5);

  const freshness = clamp(safeNumber(input.freshness, 0) / 30, 0, 1.4);
  const pressure = clamp(getRunnerPressure(input) / 2.5, -1, 1.6);
  const acceleration = clamp(getRunnerAcceleration(input) / 2, -1, 1.5);

  let flow = -0.5;
  if (flowName === "SQUEEZE") flow = 1.6;
  else if (flowName === "RUNNING") flow = 1.35;
  else if (flowName === "BREAKOUT") flow = 1.0;
  else if (flowName === "BUILDING") flow = 0.45;
  else if (flowName === "EXHAUSTION") flow = -1.3;

  let volatility = 0;
  const vol = String(input.volatility || input.regime || "").toUpperCase();

  if (vol === "HIGH" || vol === "HIGH_VOL") volatility = 0.75;
  else if (vol === "MID" || vol === "MEDIUM" || vol === "MID_VOL") volatility = 0.45;
  else if (vol === "LOW" || vol === "LOW_VOL") volatility = -0.35;
  else volatility = 0;

  let runnerSetup = -0.4;
  const entryType = String(input.entryType || input.runnerEntryType || input.sniper || "").toUpperCase();

  if (entryType.includes("SQUEEZE")) runnerSetup = 1.3;
  else if (entryType.includes("BREAKOUT")) runnerSetup = 1.15;
  else if (entryType.includes("CONTINUATION")) runnerSetup = 0.95;
  else if (entryType.includes("RETEST")) runnerSetup = 0.8;

  const spoof = input.spoof || input.ob?.spoof ? -1.4 : 0.35;

  let macro = 0;
  const macroInput = String(input.macro || input.btcState || "").toUpperCase();

  if (macroInput === "ALIGNED" || macroInput === "RUNNER_BULL" || macroInput === "RUNNER_BEAR") macro = 0.8;
  else if (macroInput === "NEUTRAL") macro = 0.25;
  else if (macroInput === "MISALIGNED") macro = -0.8;

  let stage = -0.3;
  if (stageName === "ENTRY") stage = 1.2;
  else if (stageName === "ALMOST") stage = 0.7;
  else if (stageName === "BUILDUP") stage = 0.2;
  else if (stageName === "RADAR") stage = -0.25;

  const obQuality = clamp(safeNumber(input.obQuality ?? input.qualityScore ?? input.ob?.qualityScore, 0) / 100, 0, 1.1);

  return {
    moveScore,
    confluence,
    rr,
    vm,
    edge,
    freshness,
    pressure,
    acceleration,
    flow,
    volatility,
    runnerSetup,
    spoof,
    macro,
    stage,
    obQuality
  };
}

// ================= WEIGHTS =================
const W = {
  moveScore: 1.35,
  confluence: 1.45,
  rr: 1.35,
  vm: 0.85,
  edge: 0.75,
  freshness: 1.10,
  pressure: 1.25,
  acceleration: 1.05,
  flow: 1.35,
  volatility: 0.45,
  runnerSetup: 1.05,
  spoof: 1.15,
  macro: 0.65,
  stage: 0.75,
  obQuality: 0.70
};

const BIAS = -2.65;

// ================= META MODEL =================
export function metaModel(input = {}) {
  const x = extractMetaVector(input);

  const z =
    (x.moveScore * W.moveScore) +
    (x.confluence * W.confluence) +
    (x.rr * W.rr) +
    (x.vm * W.vm) +
    (x.edge * W.edge) +
    (x.freshness * W.freshness) +
    (x.pressure * W.pressure) +
    (x.acceleration * W.acceleration) +
    (x.flow * W.flow) +
    (x.volatility * W.volatility) +
    (x.runnerSetup * W.runnerSetup) +
    (x.spoof * W.spoof) +
    (x.macro * W.macro) +
    (x.stage * W.stage) +
    (x.obQuality * W.obQuality) +
    BIAS;

  const probability = sigmoid(z);

  return {
    profile: "RUNNER",
    probability,
    probabilityPct: Number((probability * 100).toFixed(2)),
    rawScore: Number(z.toFixed(4)),
    vector: x,
    confidence:
      probability >= 0.82 ? "ELITE" :
      probability >= 0.68 ? "HIGH" :
      probability >= 0.54 ? "MEDIUM" :
      "LOW"
  };
}

// ================= META DECISION =================
export function metaDecision(meta) {
  const p = safeNumber(meta?.probability, 0);

  if (p >= 0.82) {
    return {
      label: "EXECUTE",
      quality: "ELITE",
      runnerAction: "ENTRY_ALLOWED"
    };
  }

  if (p >= 0.68) {
    return {
      label: "WATCH",
      quality: "HIGH",
      runnerAction: "WAIT_FOR_CONFIRMATION"
    };
  }

  if (p >= 0.54) {
    return {
      label: "MONITOR",
      quality: "MEDIUM",
      runnerAction: "KEEP_ON_RADAR"
    };
  }

  return {
    label: "REJECT",
    quality: "LOW",
    runnerAction: "NO_TRADE"
  };
}