import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

export const SETTINGS = {
  CG_TOP: 1500,
  RADAR_LIMIT: 260,
  BUILDUP_LIMIT: 170,
  ALMOST_LIMIT: 120,
  ENTRY_LIMIT: 90,

  radar: {
    mcapMin: 4_000_000,
    mcapMax: 3_000_000_000,
    volMin: 120_000,
    vmMin: 0.010,
    maxAbsChg24: 110,
    maxRange24: 140,
    dir1hMinBull: 0.20,
    dir24MinBull: 0.50,
    dir1hMaxBear: -0.00,
    dir24MaxBear: -0.08,
  },

  buildup: {
    minVolAcc: 0.78,
  },

  almost: {
    minConfidence: 8,
    maxFlat60Pct: 44.0,
  },

  entry: {
    samplesNeed: 2,
    samplesWindowSec: 3 * 3600,
    samplesMax: 24,
    samplesTtlSec: 60 * 60 * 48,
    resultTtlSec: 60 * 45,
    minAgree: 1,

    minConfidence: 9,
    obScoreMin: 0.0008,
    spreadMaxPct: 5.2,
    depthMinUsd1p: 800,

    adaptiveTiers: [
      {
        maxMc: 80_000_000,
        minConf: 10,
        spreadMax: 5.2,
        depth1pMin: 800,
        obScoreMin: 0.0008,
      },
      {
        maxMc: 250_000_000,
        minConf: 9,
        spreadMax: 4.8,
        depth1pMin: 1_250,
        obScoreMin: 0.0013,
      },
      {
        maxMc: 900_000_000,
        minConf: 8,
        spreadMax: 4.2,
        depth1pMin: 2_000,
        obScoreMin: 0.0021,
      },
      {
        maxMc: 3_000_000_000,
        minConf: 7,
        spreadMax: 3.7,
        depth1pMin: 3_200,
        obScoreMin: 0.0030,
      },
    ],

    obSlopeEnabled: true,
    obSlopeMinBull: 0,
    obSlopeMinBear: 0,
    obSlopeField: "score",

    dyn: {
      spreadHardMaxPct: 6.2,
      spreadHardMinPct: 0.25,
      depthHardMinUsd: 500,
      depthHardMaxUsd: 300_000,
      obScoreHardMin: 0.0003,
      obScoreHardMax: 0.05,
    },
  },

  btc: {
    softOpenNeutral: true,
    bullMinChg24: 0.45,
    bearMaxChg24: -0.9,
  },
};

const BLOCKED_EXACT = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "DAI",
  "TUSD",
  "FDUSD",
  "USDE",
  "USDD",
  "PYUSD",
  "USD1",
  "EURC",
  "EURI",
  "GUSD",
  "FRAX",
  "MIM",
  "LUSD",
  "USDP",
  "UST",
  "USTC",
  "WBTC",
  "WETH",
  "STETH",
  "WEETH",
  "WSTETH",
]);

export function getCfg() {
  return SETTINGS;
}

export function keyLatest(mode = "bear") {
  return `latest:${String(mode).toLowerCase()}`;
}

export function keyState(mode = "bear") {
  return `state:${String(mode).toLowerCase()}`;
}

export function keyReset(mode = "bear") {
  return `reset:${String(mode).toLowerCase()}`;
}

export function keyObSamples(mode = "bear", sym) {
  return `ob:samples:${String(mode).toLowerCase()}:${String(sym || "").toUpperCase()}`;
}

export function keyObResult(mode = "bear", sym) {
  return `ob:result:${String(mode).toLowerCase()}:${String(sym || "").toUpperCase()}`;
}

export function keyObResultMapTs(mode = "bear") {
  return `ob:mapts:${String(mode).toLowerCase()}`;
}

export function keyDiagList(mode = "bear") {
  return `diag:list:${String(mode).toLowerCase()}`;
}

export function keyDiagSnap(mode = "bear") {
  return `diag:snap:${String(mode).toLowerCase()}`;
}

export const keyEntryLog = "logs:entry:bear";

function up(x) {
  return String(x || "").toUpperCase();
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(x, a, b) {
  const v = Number(x);
  return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : a;
}

export function isBlockedMainAsset(coin) {
  const sym = up(coin?.symbol || "");
  const name = String(coin?.name || "").toLowerCase();

  if (!sym) return true;
  if (BLOCKED_EXACT.has(sym)) return true;

  if (
    sym.endsWith("USD") ||
    sym.endsWith("EUR") ||
    name.includes("stablecoin") ||
    name.includes("bridged usdc") ||
    name.includes("bridged usdt") ||
    name.includes("wrapped bitcoin") ||
    name.includes("wrapped ether") ||
    name.includes("liquid staked") ||
    name.includes("staked ether")
  ) {
    return true;
  }

  return false;
}

export function computeVm(volume, marketCap) {
  const v = Number(volume || 0);
  const m = Number(marketCap || 0);
  return v > 0 && m > 0 ? v / m : 0;
}

export function computeRangePct(high24, low24) {
  const hi = Number(high24 || 0);
  const lo = Number(low24 || 0);
  return hi > 0 && lo > 0 ? ((hi - lo) / lo) * 100 : 0;
}

export function computeBtcState(btc, settings = SETTINGS) {
  const chg24 = Number(btc?.chg24 || 0);
  const bullMin = Number(settings?.btc?.bullMinChg24 ?? 0.45);
  const bearMax = Number(settings?.btc?.bearMaxChg24 ?? -0.9);

  if (chg24 >= bullMin) return "BULL";
  if (chg24 <= bearMax) return "BEAR";
  return "NEUTRAL";
}

export function computeConfidence({ vm, change24, range24, obValid }) {
  const vmVal = Number(vm || 0);
  const ch24 = Math.abs(Number(change24 || 0));
  const r24 = Number(range24 || 0);

  let c = 0;

  c += Math.max(0, Math.min(40, (vmVal / 0.26) * 40));
  c += Math.max(0, Math.min(22, (ch24 / 12) * 22));
  c += Math.max(0, 18 - Math.min(18, r24 / 3.5));
  if (obValid) c += 10;

  if (ch24 < 0.60) c -= 16;
  if (ch24 < 0.25) c -= 12;
  if (r24 < 1.20) c -= 16;
  if (r24 < 0.60) c -= 10;

  return Math.max(0, Math.min(100, Math.round(c)));
}

export function dynamicRadarThresholds(range24Pct, settings = SETTINGS) {
  const R = settings?.radar || {};
  const r = clamp(range24Pct, 0, 220);
  const s = clamp((r - 8) / (34 - 8), 0, 1);

  const base1hBull = Number(R.dir1hMinBull ?? 0.20);
  const base24Bull = Number(R.dir24MinBull ?? 0.50);
  const base1hBear = Number(R.dir1hMaxBear ?? -0.00);
  const base24Bear = Number(R.dir24MaxBear ?? -0.08);

  const bull1h = clamp(base1hBull + s * 0.06, 0.02, 0.40);
  const bull24 = clamp(base24Bull + s * 0.12, 0.05, 1.30);
  const bear1hAbs = clamp(Math.abs(base1hBear) * (0.62 + 0.55 * s), 0.02, 0.40);
  const bear24Abs = clamp(Math.abs(base24Bear) * (0.62 + 0.55 * s), 0.02, 1.15);

  const baseMaxRange = Number(R.maxRange24 ?? 140);
  const dynMaxRange = clamp(baseMaxRange + s * 14, 75, 160);

  return {
    maxRange24: dynMaxRange,
    dir1hMinBull: bull1h,
    dir24MinBull: bull24,
    dir1hMaxBear: -bear1hAbs,
    dir24MaxBear: -bear24Abs,
    scale: s,
  };
}

export function dynamicEntryThresholds({ marketCap, volume, vm }, baseThr, settings = SETTINGS) {
  const entry = settings?.entry || {};
  const dyn = entry?.dyn || {};

  const mc = Math.max(0, Number(marketCap || 0));
  const vol = Math.max(0, Number(volume || 0));
  const vmr = Math.max(0, Number(vm || 0));
  const thr = { ...(baseThr || {}) };

  const volScore = clamp(
    (Math.log10(vol + 1) - Math.log10(120_000 + 1)) /
      (Math.log10(60_000_000 + 1) - Math.log10(120_000 + 1)),
    0,
    1
  );

  const mcScore = clamp(
    (Math.log10(mc + 1) - Math.log10(4_000_000 + 1)) /
      (Math.log10(3_000_000_000 + 1) - Math.log10(4_000_000 + 1)),
    0,
    1
  );

  const vmScore = clamp((vmr - 0.010) / (0.60 - 0.010), 0, 1);

  const liq = clamp(0.52 * volScore + 0.30 * vmScore + 0.18 * mcScore, 0, 1);

  const spreadBase = Number(thr.spreadMaxPct ?? entry.spreadMaxPct ?? 5.2);
  const spreadAdj = (1 - liq) * 0.26 - liq * 0.05;
  let spreadMaxPct = spreadBase * (1 + spreadAdj);
  spreadMaxPct = clamp(
    spreadMaxPct,
    Number(dyn.spreadHardMinPct ?? 0.25),
    Number(dyn.spreadHardMaxPct ?? 6.2)
  );

  const depthBase = Number(thr.depthMinUsd1p ?? entry.depthMinUsd1p ?? 800);
  const depthAdj = 0.72 + 0.50 * liq;
  let depthMinUsd1p = Math.round(depthBase * depthAdj);
  depthMinUsd1p = Math.round(
    clamp(
      depthMinUsd1p,
      Number(dyn.depthHardMinUsd ?? 500),
      Number(dyn.depthHardMaxUsd ?? 300_000)
    )
  );

  const scoreBase = Number(thr.obScoreMin ?? entry.obScoreMin ?? 0.0008);
  const scoreAdj = (1 - liq) * 0.16 - liq * 0.05;
  let obScoreMin = scoreBase * (1 + scoreAdj);
  obScoreMin = clamp(
    obScoreMin,
    Number(dyn.obScoreHardMin ?? 0.0003),
    Number(dyn.obScoreHardMax ?? 0.05)
  );

  return { ...thr, spreadMaxPct, depthMinUsd1p, obScoreMin, liqScore: liq };
}

function filterFreshSamples(samples, windowSec, field = "score") {
  const arr = Array.isArray(samples) ? samples : [];
  const win = Math.max(60, Number(windowSec || 0)) * 1000;
  const now = Date.now();

  return arr
    .map((s) => ({ ts: Number(s?.ts || 0), y: Number(s?.[field]) }))
    .filter((x) => x.ts > 0 && Number.isFinite(x.y) && now - x.ts <= win)
    .sort((a, b) => a.ts - b.ts);
}

export function calcSlopeFromSamplesPoints(points) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length < 2) return 0;

  const sorted = pts
    .map((p) => ({ t: Number(p?.ts || p?.t || 0), y: Number(p?.y) }))
    .filter((p) => p.t > 0 && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);

  if (sorted.length < 2) return 0;

  const t0 = sorted[0].t;
  const xs = sorted.map((p) => (p.t - t0) / 60000);
  const ys = sorted.map((p) => p.y);

  const nPts = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / nPts;
  const meanY = ys.reduce((a, b) => a + b, 0) / nPts;

  let num = 0;
  let den = 0;

  for (let i = 0; i < nPts; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }

  return den === 0 ? 0 : num / den;
}

export function slopePass(mode, slope, slopeMin) {
  const m = String(mode || "").toLowerCase();
  const sMin = Number(slopeMin || 0);

  if (m === "bull") return slope >= sMin;
  if (m === "bear") return slope <= -sMin;
  return false;
}

export function extractTailSamples(samples, need) {
  const nNeed = Math.max(0, Number(need || 0));
  const arr = Array.isArray(samples) ? samples : [];
  return nNeed > 0 ? arr.slice(-nNeed) : arr;
}

export function checkObSlopeGate({ stage, mode = "bear", obSamples, settings = SETTINGS }) {
  const m = String(mode || "bear").toLowerCase();
  const st = String(stage || "entry").toLowerCase();
  const entryCfg = settings?.entry || {};
  const enabled = !!entryCfg.obSlopeEnabled;

  if (!enabled) return { ok: true, slope: 0, reason: "disabled" };

  const windowSec = Number(entryCfg.samplesWindowSec || 0);
  const need = Number(entryCfg.samplesNeed || 0);
  const field = String(entryCfg.obSlopeField || "score");
  const freshPts = filterFreshSamples(obSamples, windowSec, field);
  const tail = extractTailSamples(freshPts, need);
  const minPts = Math.max(2, need);

  if (!Array.isArray(tail) || tail.length < minPts) {
    return {
      ok: false,
      slope: 0,
      reason: `OB slope: insufficient FRESH samples in ${st} (${tail?.length || 0}/${minPts})`,
    };
  }

  const slopeMin =
    m === "bull"
      ? Number(entryCfg.obSlopeMinBull || 0)
      : Number(entryCfg.obSlopeMinBear || 0);

  const slope = calcSlopeFromSamplesPoints(tail);

  if (!slopePass(m, slope, slopeMin)) {
    return {
      ok: false,
      slope,
      reason: `OB slope failed in ${st} (mode=${m}, slope=${slope.toFixed(6)}, min=${slopeMin})`,
    };
  }

  return { ok: true, slope, reason: "OK" };
}

export default {
  SETTINGS,
  getCfg,
  keyLatest,
  keyState,
  keyReset,
  keyObSamples,
  keyObResult,
  keyObResultMapTs,
  keyDiagList,
  keyDiagSnap,
  keyEntryLog,
  isBlockedMainAsset,
  computeVm,
  computeRangePct,
  computeBtcState,
  computeConfidence,
  dynamicRadarThresholds,
  dynamicEntryThresholds,
  checkObSlopeGate,
};