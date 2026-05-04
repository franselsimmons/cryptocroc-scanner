import { getLiquidityZones } from "./liquidityEngine.js";

const MARKET_CONTEXT_TTL_MS = 45 * 1000;
const marketContextCache = new Map();

const ATR_PERIOD = 14;

// ================= CONSTANTS =================
const MIN_RISK_PCT = 0.0045;
const BASE_MAX_RISK_PCT = 0.040;
const HIGH_VOL_MAX_RISK_PCT = 0.060;
const LOW_VOL_MAX_RISK_PCT = 0.026;

const DEFAULT_ATR_PCT = 0.010;
const MIN_ATR_PCT = 0.0015;
const MAX_ATR_PCT = 0.085;

const BASE_RR = 1.35;
const MIN_TARGET_RR = 1.15;
const MAX_TARGET_RR = 2.40;

// ================= HELPERS =================
function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSpread(spreadPct) {
  let s = Number(spreadPct || 0);

  if (!Number.isFinite(s) || s < 0) return 0.001;
  if (s > 0.05) s = s / 100;

  return s;
}

function normalizeBitgetSymbol(raw) {
  let clean = String(raw || "")
    .toUpperCase()
    .trim()
    .replace(/_UMCBL$/, "")
    .replace(/_DMCBL$/, "")
    .replace(/_CMCBL$/, "")
    .replace(/-UMCBL$/, "")
    .replace(/-DMCBL$/, "")
    .replace(/-CMCBL$/, "");

  if (!clean) return "";

  if (!clean.endsWith("USDT") && !clean.endsWith("USDC")) {
    clean = `${clean}USDT`;
  }

  return clean;
}

function normalizeAtrPct(value) {
  const n = safeNumber(value, 0);

  if (n <= 0) return 0;

  if (n > 0.30) {
    return clamp(n / 100, MIN_ATR_PCT, MAX_ATR_PCT);
  }

  return clamp(n, MIN_ATR_PCT, MAX_ATR_PCT);
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
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

function riskReward({ price, sl, tp, isBull }) {
  const risk = isBull ? price - sl : sl - price;
  const reward = isBull ? tp - price : price - tp;

  if (risk <= 0 || reward <= 0) return 0;

  return reward / risk;
}

// ================= FETCH =================
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`req failed ${res.status}`);
  }

  return await res.json();
}

async function fetchKlinesBitget(symbol, interval, limit) {
  const clean = normalizeBitgetSymbol(symbol);
  if (!clean) return [];

  const granularityMap = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "4h": "4H"
  };

  const granularity = granularityMap[interval] || interval;

  const url =
    `https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(clean)}&productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await fetchJson(url);

      if (!Array.isArray(json?.data)) return [];

      return json.data
        .map(c => ({
          openTime: Number(c[0]),
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4])
        }))
        .filter(c => {
          return (
            Number.isFinite(c.openTime) &&
            c.open > 0 &&
            c.high > 0 &&
            c.low > 0 &&
            c.close > 0
          );
        })
        .sort((a, b) => a.openTime - b.openTime);
    } catch {
      await sleep(150);
    }
  }

  return [];
}

// ================= ATR =================
function calculateATR(candles, period = ATR_PERIOD) {
  if (!Array.isArray(candles) || candles.length < period + 1) return 0;

  const slice = candles.slice(-(period + 1));
  let sum = 0;

  for (let i = 1; i < slice.length; i++) {
    const high = slice[i].high;
    const low = slice[i].low;
    const prevClose = slice[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    sum += tr;
  }

  return sum / period;
}

function estimateFallbackAtrPct(c, spread) {
  const fromScanner = Math.max(
    normalizeAtrPct(c?.atrPct15m),
    normalizeAtrPct(c?.atrPct1h) * 0.75,
    normalizeAtrPct(c?.atrPct4h) * 0.45
  );

  if (fromScanner > 0) {
    return clamp(fromScanner, MIN_ATR_PCT, MAX_ATR_PCT);
  }

  const ch1Abs = Math.abs(safeNumber(c?.change1h, 0));
  const ch24Abs = Math.abs(safeNumber(c?.change24, 0));
  const vm = safeNumber(c?.vm, 0);
  const freshness = safeNumber(c?.freshness, 0);
  const pressure = Math.abs(safeNumber(c?.runnerPressure, 0));

  const estimated =
    (ch1Abs / 100) * 0.62 +
    (ch24Abs / 100) * 0.065 +
    vm * 0.024 +
    freshness * 0.00022 +
    pressure * 0.0018;

  return clamp(
    Math.max(estimated, spread * 3.5, DEFAULT_ATR_PCT),
    MIN_ATR_PCT,
    MAX_ATR_PCT
  );
}

// ================= MARKET CONTEXT =================
async function getMarketContext(symbol, price, rawBitgetSymbol) {
  const contractSymbol = normalizeBitgetSymbol(rawBitgetSymbol || symbol);
  if (!contractSymbol) return null;

  const cached = marketContextCache.get(contractSymbol);
  if (cached && Date.now() - cached.ts < MARKET_CONTEXT_TTL_MS) {
    return cached.data;
  }

  const [c5m, c15m, c1h] = await Promise.all([
    fetchKlinesBitget(contractSymbol, "5m", 80),
    fetchKlinesBitget(contractSymbol, "15m", 100),
    fetchKlinesBitget(contractSymbol, "1h", 100)
  ]);

  if (c5m.length < ATR_PERIOD + 1 || c15m.length < ATR_PERIOD + 1) {
    return null;
  }

  const atr5m = calculateATR(c5m);
  const atr15m = calculateATR(c15m);
  const atr1h = calculateATR(c1h);

  const lastPrice = safeNumber(price, c5m[c5m.length - 1]?.close || 0);
  if (lastPrice <= 0) return null;

  const weightedATR =
    (atr5m * 0.25) +
    (atr15m * 0.45) +
    (atr1h * 0.30);

  const atrPct = weightedATR / lastPrice;

  const data = {
    source: "BITGET_ATR",
    symbol: contractSymbol,
    atr: {
      value: weightedATR,
      pct: clamp(atrPct, MIN_ATR_PCT, MAX_ATR_PCT),
      atr5m,
      atr15m,
      atr1h
    },
    candles: {
      c5m: c5m.length,
      c15m: c15m.length,
      c1h: c1h.length
    }
  };

  marketContextCache.set(contractSymbol, {
    data,
    ts: Date.now()
  });

  return data;
}

// ================= RISK MODEL =================
function getMaxRiskPct(c) {
  const ch1Abs = Math.abs(safeNumber(c?.change1h, 0));
  const ch24Abs = Math.abs(safeNumber(c?.change24, 0));
  const flow = String(c?.flow || "").toUpperCase();

  if (flow === "SQUEEZE") return HIGH_VOL_MAX_RISK_PCT;
  if (ch24Abs > 10 || ch1Abs > 2.5) return HIGH_VOL_MAX_RISK_PCT;
  if (ch24Abs < 2 && ch1Abs < 0.35) return LOW_VOL_MAX_RISK_PCT;

  return BASE_MAX_RISK_PCT;
}

function buildRiskDistance({ price, atrPct, spread, c }) {
  const flow = String(c?.flow || "").toUpperCase();
  const score = safeNumber(c?.moveScore, 0);
  const acceleration = safeNumber(c?.runnerAcceleration, 0);

  let atrMult = 1.55;

  if (flow === "SQUEEZE") atrMult = 1.35;
  if (flow === "RUNNING") atrMult = 1.45;
  if (flow === "BREAKOUT") atrMult = 1.55;
  if (flow === "BUILDING") atrMult = 1.75;

  if (score > 88 && acceleration > 0.5) atrMult -= 0.10;

  const atrDist = price * Math.max(
    atrPct * atrMult,
    spread * 4.0,
    0.0048
  );

  const minRisk = price * MIN_RISK_PCT;
  const maxRisk = price * getMaxRiskPct(c);

  return clamp(atrDist, minRisk, maxRisk);
}

function pickLongSL({ price, riskDist, liquidity }) {
  const atrSL = price - riskDist;
  const minRiskSL = price * (1 - MIN_RISK_PCT);
  const maxRiskSL = price - (price * BASE_MAX_RISK_PCT);

  const structureCandidates = [
    liquidity?.supportSweep,
    liquidity?.support,
    liquidity?.orderbookSupport,
    liquidity?.bullInvalidation
  ].filter(v => validBelow(price, v));

  if (!structureCandidates.length) return atrSL;

  const closestStructure = Math.max(...structureCandidates.map(Number));
  const structureRisk = price - closestStructure;

  if (structureRisk < price * MIN_RISK_PCT) return minRiskSL;
  if (closestStructure < maxRiskSL) return atrSL;

  return Math.min(closestStructure, minRiskSL);
}

function pickShortSL({ price, riskDist, liquidity }) {
  const atrSL = price + riskDist;
  const minRiskSL = price * (1 + MIN_RISK_PCT);
  const maxRiskSL = price + (price * BASE_MAX_RISK_PCT);

  const structureCandidates = [
    liquidity?.resistanceSweep,
    liquidity?.resistance,
    liquidity?.orderbookResistance,
    liquidity?.bearInvalidation
  ].filter(v => validAbove(price, v));

  if (!structureCandidates.length) return atrSL;

  const closestStructure = Math.min(...structureCandidates.map(Number));
  const structureRisk = closestStructure - price;

  if (structureRisk < price * MIN_RISK_PCT) return minRiskSL;
  if (closestStructure > maxRiskSL) return atrSL;

  return Math.max(closestStructure, minRiskSL);
}

function pickLongTP({ price, risk, liquidity, liquidation, c }) {
  const flow = String(c?.flow || "").toUpperCase();
  const dynamicRR = flow === "SQUEEZE" ? 1.65 : flow === "RUNNING" ? 1.50 : BASE_RR;
  const baseTP = price + risk * dynamicRR;

  const candidates = [
    liquidation?.runnerTargets?.bull,
    liquidity?.resistance,
    liquidity?.resistanceSweep,
    liquidity?.orderbookResistance,
    liquidation?.nearestAbove,
    liquidation?.majorAbove
  ]
    .filter(v => validAbove(price, v))
    .map(Number)
    .sort((a, b) => a - b);

  for (const target of candidates) {
    const rr = (target - price) / risk;

    if (rr >= MIN_TARGET_RR && rr <= MAX_TARGET_RR) {
      return target;
    }
  }

  return baseTP;
}

function pickShortTP({ price, risk, liquidity, liquidation, c }) {
  const flow = String(c?.flow || "").toUpperCase();
  const dynamicRR = flow === "SQUEEZE" ? 1.65 : flow === "RUNNING" ? 1.50 : BASE_RR;
  const baseTP = price - risk * dynamicRR;

  const candidates = [
    liquidation?.runnerTargets?.bear,
    liquidity?.support,
    liquidity?.supportSweep,
    liquidity?.orderbookSupport,
    liquidation?.nearestBelow,
    liquidation?.majorBelow
  ]
    .filter(v => validBelow(price, v))
    .map(Number)
    .sort((a, b) => b - a);

  for (const target of candidates) {
    const rr = (price - target) / risk;

    if (rr >= MIN_TARGET_RR && rr <= MAX_TARGET_RR) {
      return target;
    }
  }

  return baseTP;
}

function buildRunnerExitPlan({ price, sl, tp, isBull, rr }) {
  const risk = Math.abs(price - sl);

  const partialTp = isBull
    ? price + risk * 1.0
    : price - risk * 1.0;

  const breakevenAt = partialTp;

  const trailStart = isBull
    ? price + risk * 1.6
    : price - risk * 1.6;

  return {
    partialTp,
    breakevenAt,
    trailStart,
    runnerTarget: tp,
    rr,
    useTrailing: rr >= 1.25
  };
}

// ================= CORE =================
export async function calculateRisk(c, ob = {}, liquidity = null, liquidation = null) {
  const price = safeNumber(c?.price, 0);
  const side = normalizeSide(c?.side);
  const isBull = side === "bull";

  if (price <= 0) {
    return {
      entry: 0,
      sl: 0,
      tp: 0,
      rr: 0,
      riskPct: 0,
      rewardPct: 0,
      atrPct: 0,
      slSource: "INVALID_PRICE",
      tpSource: "INVALID_PRICE",
      contextSource: "NONE",
      allowEntry: false
    };
  }

  const spread = normalizeSpread(ob?.spreadPct);

  const ctx = await getMarketContext(
    c?.symbol,
    price,
    c?.rawBitgetSymbol
  );

  const atrPct = ctx?.atr?.pct
    ? normalizeAtrPct(ctx.atr.pct)
    : estimateFallbackAtrPct(c, spread);

  const contextSource = ctx?.source || "SCANNER_FALLBACK_ATR";
  const zones = liquidity || getLiquidityZones(c, ob);

  const riskDist = buildRiskDistance({
    price,
    atrPct,
    spread,
    c
  });

  let sl;
  let tp;

  if (isBull) {
    sl = pickLongSL({ price, riskDist, liquidity: zones });

    const risk = price - sl;

    tp = pickLongTP({
      price,
      risk,
      liquidity: zones,
      liquidation,
      c
    });
  } else {
    sl = pickShortSL({ price, riskDist, liquidity: zones });

    const risk = sl - price;

    tp = pickShortTP({
      price,
      risk,
      liquidity: zones,
      liquidation,
      c
    });
  }

  const risk = Math.abs(price - sl);
  let reward = Math.abs(tp - price);

  let rr = riskReward({
    price,
    sl,
    tp,
    isBull
  });

  if (!Number.isFinite(rr) || rr < MIN_TARGET_RR) {
    if (isBull) tp = price + risk * BASE_RR;
    else tp = price - risk * BASE_RR;

    rr = riskReward({ price, sl, tp, isBull });
    reward = Math.abs(tp - price);
  }

  const exitPlan = buildRunnerExitPlan({
    price,
    sl,
    tp,
    isBull,
    rr
  });

  return {
    entry: price,
    sl,
    tp,
    rr,

    riskAbs: risk,
    rewardAbs: reward,

    riskPct: risk / price,
    rewardPct: reward / price,

    atrPct,
    spreadPct: spread,

    partialTp: exitPlan.partialTp,
    breakevenAt: exitPlan.breakevenAt,
    trailStart: exitPlan.trailStart,
    useTrailing: exitPlan.useTrailing,

    slSource: zones?.useWalls ? "ATR+ORDERBOOK_LIQUIDITY" : "ATR",
    tpSource: liquidation?.clusters?.length ? "ATR+LIQUIDATION_RUNNER" : "ATR+LIQUIDITY_RUNNER",

    contextSource,
    hasMarketContext: Boolean(ctx),
    hasLiquidity: Boolean(zones),
    hasLiquidation: Array.isArray(liquidation?.clusters) && liquidation.clusters.length > 0,

    allowEntry: rr >= MIN_TARGET_RR
  };
}

export function clearRiskContextCache() {
  marketContextCache.clear();

  return {
    ok: true,
    cleared: true,
    at: Date.now()
  };
}