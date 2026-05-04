// lib/liquidityEngine.js

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) {
    return 0.001;
  }

  // Soms komt spread binnen als percentage zoals 0.07, soms als ratio.
  if (s > 0.05) {
    s = s / 100;
  }

  return s;
}

function isValidPrice(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validBelow(price, value) {
  return isValidPrice(value) && Number(value) < Number(price);
}

function validAbove(price, value) {
  return isValidPrice(value) && Number(value) > Number(price);
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

function getDirectionalChange(c) {
  const side = normalizeSide(c?.side);
  const dir = side === "bear" ? -1 : 1;

  return {
    side,
    ch1: safeNumber(c?.change1h, 0) * dir,
    ch24: safeNumber(c?.change24, 0) * dir
  };
}

function getOrderbookSupport(price, ob = {}) {
  if (validBelow(price, ob?.liveSupport)) return Number(ob.liveSupport);

  if (validBelow(price, ob?.supportLevels?.[0]?.price)) {
    return Number(ob.supportLevels[0].price);
  }

  return null;
}

function getOrderbookResistance(price, ob = {}) {
  if (validAbove(price, ob?.liveResistance)) return Number(ob.liveResistance);

  if (validAbove(price, ob?.resistanceLevels?.[0]?.price)) {
    return Number(ob.resistanceLevels[0].price);
  }

  return null;
}

// ================= LIQUIDITY ENGINE =================
export function getLiquidityZones(c, ob = {}) {
  const price = safeNumber(c?.price, 0);

  if (!price) {
    return {
      support: 0,
      resistance: 0,
      supportSweep: 0,
      resistanceSweep: 0,
      mid: 0,

      bullTarget: 0,
      bearTarget: 0,
      bullInvalidation: 0,
      bearInvalidation: 0,

      rangePct: 0,
      sweepBuffer: 0,

      orderbookSupport: null,
      orderbookResistance: null,
      useWalls: false,

      runnerContext: null
    };
  }

  const spread = normalizeSpread(ob?.spreadPct);
  const depth = safeNumber(ob?.depthMinUsd1p, 200_000);
  const strength = safeNumber(c?.moveScore, 0);
  const freshness = safeNumber(c?.freshness, 0);

  const directional = getDirectionalChange(c);

  const ch24Pct = Math.abs(safeNumber(c?.change24, 5)) / 100;
  const ch1Pct = Math.abs(safeNumber(c?.change1h, 0)) / 100;

  // Runner: 1h move bepaalt de directe range sterker dan 24h.
  let rangePct = clamp((ch24Pct * 0.28) + (ch1Pct * 0.85), 0.008, 0.055);

  if (strength > 88) rangePct *= 1.12;
  if (freshness > 18) rangePct *= 1.08;

  if (depth < 100_000) rangePct *= 1.22;
  else if (depth < 180_000) rangePct *= 1.10;

  if (depth > 500_000) rangePct *= 0.86;

  if (directional.ch1 < 0) {
    rangePct *= 0.90;
  }

  rangePct = clamp(rangePct, 0.006, 0.070);

  const sweepBuffer = Math.max(spread * 2.2, 0.0012);

  const fallbackSupport = price * (1 - rangePct);
  const fallbackResistance = price * (1 + rangePct);

  const orderbookSupport = getOrderbookSupport(price, ob);
  const orderbookResistance = getOrderbookResistance(price, ob);

  const support = orderbookSupport || fallbackSupport;
  const resistance = orderbookResistance || fallbackResistance;

  const supportSweep = support * (1 - sweepBuffer);
  const resistanceSweep = resistance * (1 + sweepBuffer);

  const bullTarget = resistance;
  const bearTarget = support;

  const bullInvalidation = supportSweep;
  const bearInvalidation = resistanceSweep;

  const runnerContext = getRunnerLiquidityContext(
    {
      ...c,
      price
    },
    {
      support,
      resistance,
      supportSweep,
      resistanceSweep,
      mid: price
    }
  );

  return {
    support,
    resistance,
    supportSweep,
    resistanceSweep,
    mid: price,

    bullTarget,
    bearTarget,
    bullInvalidation,
    bearInvalidation,

    rangePct,
    sweepBuffer,

    orderbookSupport,
    orderbookResistance,
    useWalls: Boolean(orderbookSupport || orderbookResistance),

    runnerContext
  };
}

export function getRunnerLiquidityContext(c, liquidity = {}) {
  const side = normalizeSide(c?.side);
  const price = safeNumber(c?.price, 0);

  if (!price) {
    return {
      side,
      valid: false,
      target: 0,
      invalidation: 0,
      distanceToTargetPct: 0,
      distanceToInvalidationPct: 0,
      breakoutState: "UNKNOWN"
    };
  }

  const support = safeNumber(liquidity?.support, 0);
  const resistance = safeNumber(liquidity?.resistance, 0);
  const supportSweep = safeNumber(liquidity?.supportSweep, 0);
  const resistanceSweep = safeNumber(liquidity?.resistanceSweep, 0);

  const target = side === "bull" ? resistance : support;
  const invalidation = side === "bull" ? supportSweep : resistanceSweep;

  const distanceToTargetPct = target > 0
    ? Math.abs(target - price) / price
    : 0;

  const distanceToInvalidationPct = invalidation > 0
    ? Math.abs(price - invalidation) / price
    : 0;

  let breakoutState = "INSIDE_RANGE";

  if (side === "bull" && resistance && price > resistance) {
    breakoutState = "BULL_BREAKOUT";
  }

  if (side === "bear" && support && price < support) {
    breakoutState = "BEAR_BREAKDOWN";
  }

  if (side === "bull" && supportSweep && price < supportSweep) {
    breakoutState = "BULL_INVALIDATED";
  }

  if (side === "bear" && resistanceSweep && price > resistanceSweep) {
    breakoutState = "BEAR_INVALIDATED";
  }

  return {
    side,
    valid: Boolean(target && invalidation),
    target,
    invalidation,
    distanceToTargetPct,
    distanceToInvalidationPct,
    breakoutState
  };
}