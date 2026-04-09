import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

export const SETTINGS = {
  CG_TOP: 1500,
  RADAR_LIMIT: 300,
  BUILDUP_LIMIT: 200,
  ALMOST_LIMIT: 140,
  ENTRY_LIMIT: 90,

  radar: {
    mcapMin: 2_000_000,
    mcapMax: 5_000_000_000,
    volMin: 80_000,
    vmMin: 0.006,
    maxAbsChg24: 150,
    maxRange24: 170,
    dir1hMinBull: -0.08,
    dir24MinBull: -0.12,
    dir1hMaxBear: 0.20,
    dir24MaxBear: 0.50,
  },

  buildup: {
    minVolAcc: 0.68,
  },

  almost: {
    minConfidence: 6,
    maxFlat60Pct: 60.0,
  },

  entry: {
    samplesNeed: 2,
    samplesWindowSec: 3 * 3600,
    samplesMax: 24,
    samplesTtlSec: 60 * 60 * 48,
    resultTtlSec: 60 * 45,
    minAgree: 1,

    minConfidence: 9,
    obScoreMin: 0.0007,
    spreadMaxPct: 5.8,
    depthMinUsd1p: 700,

    adaptiveTiers: [
      {
        maxMc: 80_000_000,
        minConf: 10,
        spreadMax: 5.8,
        depth1pMin: 700,
        obScoreMin: 0.0007,
      },
      {
        maxMc: 250_000_000,
        minConf: 9,
        spreadMax: 5.2,
        depth1pMin: 1_100,
        obScoreMin: 0.0012,
      },
      {
        maxMc: 1_000_000_000,
        minConf: 8,
        spreadMax: 4.5,
        depth1pMin: 1_900,
        obScoreMin: 0.0020,
      },
      {
        maxMc: 5_000_000_000,
        minConf: 7,
        spreadMax: 3.9,
        depth1pMin: 3_000,
        obScoreMin: 0.0030,
      },
    ],

    obSlopeEnabled: true,
    obSlopeMinBull: 0,
    obSlopeMinBear: 0,
    obSlopeField: "score",

    dyn: {
      spreadHardMaxPct: 7.0,
      spreadHardMinPct: 0.25,
      depthHardMinUsd: 450,
      depthHardMaxUsd: 300_000,
      obScoreHardMin: 0.00025,
      obScoreHardMax: 0.05,
    },
  },

  btc: {
    softOpenNeutral: true,
    bullMinChg24: 0.35,
    bearMaxChg24: -1.0,
  },
};

export function getCfg() {
  return SETTINGS;
}

export function keyLatest(mode = "bull") {
  return `latest:${String(mode).toLowerCase()}`;
}

export function keyState(mode = "bull") {
  return `state:${String(mode).toLowerCase()}`;
}

export function keyReset(mode = "bull") {
  return `reset:${String(mode).toLowerCase()}`;
}

export function keyObSamples(mode = "bull", sym) {
  return `ob:samples:${String(mode).toLowerCase()}:${String(sym || "").toUpperCase()}`;
}

export function keyObResult(mode = "bull", sym) {
  return `ob:result:${String(mode).toLowerCase()}:${String(sym || "").toUpperCase()}`;
}

export function keyObResultMapTs(mode = "bull") {
  return `ob:mapts:${String(mode).toLowerCase()}`;
}

export function keyDiagList(mode = "bull") {
  return `diag:list:${String(mode).toLowerCase()}`;
}

export function keyDiagSnap(mode = "bull") {
  return `diag:snap:${String(mode).toLowerCase()}`;
}

export const keyEntryLog = "logs:entry:bull";

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
  const bullMin = Number(settings?.btc?.bullMinChg24 ?? 0.35);
  const bearMax = Number(settings?.btc?.bearMaxChg24 ?? -1.0);

  if (chg24 >= bullMin) return "BULL";
  if (chg24 <= bearMax) return "BEAR";
  return "NEUTRAL";
}

export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;
  c += Math.max(0, Math.min(42, (vm / 0.22) * 42));
  c += Math.max(0, Math.min(24, (Math.abs(change24) / 10) * 24));
  c += Math.max(0, 22 - Math.min(22, range24 / 2.8));
  if (obValid) c += 12;
  return Math.max(0, Math.min(100, Math.round(c)));
}

function clamp(x, a, b) {
  const v = Number(x);
  return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : a;
}

export function dynamicRadarThresholds(range24Pct, settings = SETTINGS) {
  const R = settings?.radar || {};
  const r = clamp(range24Pct, 0, 220);
  const s = clamp((r - 8) / (34 - 8), 0, 1);

  const base1hBull = Number(R.dir1hMinBull ?? -0.08);
  const base24Bull = Number(R.dir24MinBull ?? -0.12);
  const base1hBear = Number(R.dir1hMaxBear ?? 0.20);
  const base24Bear = Number(R.dir24MaxBear ?? 0.50);

  const bull1h = clamp(base1hBull * (0.55 + 0.65 * s), -0.18, 0.30);
  const bull24 = clamp(base24Bull * (0.55 + 0.65 * s), -0.35, 1.1);
  const bear1hAbs = clamp(Math.abs(base1hBear) * (0.60 + 0.55 * s), 0.02, 0.45);
  const bear24Abs = clamp(Math.abs(base24Bear) * (0.60 + 0.55 * s), 0.05, 1.50);

  const baseMaxRange = Number(R.maxRange24 ?? 170);
  const dynMaxRange = clamp(baseMaxRange + s * 18, 80, 190);

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
    (Math.log10(vol + 1) - Math.log10(80_000 + 1)) /
      (Math.log10(60_000_000 + 1) - Math.log10(80_000 + 1)),
    0,
    1
  );
  const mcScore = clamp(
    (Math.log10(mc + 1) - Math.log10(2_000_000 + 1)) /
      (Math.log10(5_000_000_000 + 1) - Math.log10(2_000_000 + 1)),
    0,
    1
  );
  const vmScore = clamp((vmr - 0.006) / (0.60 - 0.006), 0, 1);

  const liq = clamp(0.52 * volScore + 0.30 * vmScore + 0.18 * mcScore, 0, 1);

  const spreadBase = Number(thr.spreadMaxPct ?? entry.spreadMaxPct ?? 5.8);
  const spreadAdj = (1 - liq) * 0.30 - liq * 0.04;
  let spreadMaxPct = spreadBase * (1 + spreadAdj);
  spreadMaxPct = clamp(
    spreadMaxPct,
    Number(dyn.spreadHardMinPct ?? 0.25),
    Number(dyn.spreadHardMaxPct ?? 7.0)
  );

  const depthBase = Number(thr.depthMinUsd1p ?? entry.depthMinUsd1p ?? 700);
  const depthAdj = 0.68 + 0.52 * liq;
  let depthMinUsd1p = Math.round(depthBase * depthAdj);
  depthMinUsd1p = Math.round(
    clamp(
      depthMinUsd1p,
      Number(dyn.depthHardMinUsd ?? 450),
      Number(dyn.depthHardMaxUsd ?? 300_000)
    )
  );

  const scoreBase = Number(thr.obScoreMin ?? entry.obScoreMin ?? 0.0007);
  const scoreAdj = (1 - liq) * 0.18 - liq * 0.05;
  let obScoreMin = scoreBase * (1 + scoreAdj);
  obScoreMin = clamp(
    obScoreMin,
    Number(dyn.obScoreHardMin ?? 0.00025),
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

export function checkObSlopeGate({ stage, mode = "bull", obSamples, settings = SETTINGS }) {
  const m = String(mode || "bull").toLowerCase();
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
  computeVm,
  computeRangePct,
  computeBtcState,
  computeConfidence,
  dynamicRadarThresholds,
  dynamicEntryThresholds,
  checkObSlopeGate,
};