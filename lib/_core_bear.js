// lib/_core_bear.js
import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

/**
 * BEAR core (Scenario B):
 * - RADAR strenger (betere instroom)
 * - BUILDUP/ALMOST/ENTRY iets versoepeld (meer doorstroom)
 */
export const SETTINGS = {
  CG_TOP: 1500,

  RADAR_LIMIT: 90,
  BUILDUP_LIMIT: 45,
  ALMOST_LIMIT: 30,
  ENTRY_LIMIT: 14,

  // ===== RADAR (strenger) =====
  radar: {
    mcapMin: 15_000_000,        // was 10M
    mcapMax: 750_000_000,
    volMin: 1_600_000,          // was 1.0M
    vmMin: 0.09,                // was 0.07

    maxAbsChg24: 48,            // was 55
    maxRange24: 70,             // was 85

    // bull fields blijven bestaan voor shared code
    dir1hMinBull: 0.06,
    dir24MinBull: 0.18,

    // bear direction baseline
    dir1hMaxBear: -0.06,
    dir24MaxBear: -0.18,
  },

  // ===== BUILDUP (versoepeld) =====
  buildup: {
    minVolAcc: 1.01,            // was 1.03
  },

  // ===== ALMOST (versoepeld) =====
  almost: {
    minConfidence: 30,          // was 32
    maxFlat60Pct: 11.0,         // was 9.5
  },

  // ===== ENTRY (licht versoepeld) =====
  entry: {
    samplesNeed: 2,
    samplesWindowSec: 3 * 3600,
    samplesMax: 24,
    samplesTtlSec: 60 * 60 * 48,
    resultTtlSec: 60 * 45,

    minAgree: 1,
    minConfidence: 34,          // was 36
    obScoreMin: 0.018,          // was 0.019
    spreadMaxPct: 2.05,         // was 1.95
    depthMinUsd1p: 9_000,       // was 10k

    adaptiveTiers: [
      { maxMc: 60_000_000,  minConf: 40, spreadMax: 2.05, depth1pMin: 9_000,  obScoreMin: 0.020 },
      { maxMc: 200_000_000, minConf: 38, spreadMax: 1.80, depth1pMin: 13_000, obScoreMin: 0.022 },
      { maxMc: 750_000_000, minConf: 36, spreadMax: 1.55, depth1pMin: 21_000, obScoreMin: 0.027 },
    ],

    obSlopeEnabled: true,
    obSlopeMinBull: 0.00002,
    obSlopeMinBear: 0.00002,
    obSlopeField: "score",

    dyn: {
      spreadHardMaxPct: 2.8,
      spreadHardMinPct: 0.40,
      depthHardMinUsd: 5_500,
      depthHardMaxUsd: 260_000,
      obScoreHardMin: 0.018,    // was 0.019
      obScoreHardMax: 0.070,
    },
  },

  btc: {
    softOpenNeutral: true,
    bullMinChg24: 1.0,
    bearMaxChg24: -0.9,
  },
};

export function getCfg() {
  return SETTINGS;
}

// ================== keys ==================
export function keyLatest(mode) {
  return `latest:${String(mode || "bear").toLowerCase()}`;
}
export function keyState(mode) {
  return `state:${String(mode || "bear").toLowerCase()}`;
}
export function keyReset(mode) {
  return `reset:${String(mode || "bear").toLowerCase()}`;
}

export function keyObSamples(mode, sym) {
  return `ob:samples:${String(mode || "bear").toLowerCase()}:${String(sym).toUpperCase()}`;
}
export function keyObResult(mode, sym) {
  return `ob:result:${String(mode || "bear").toLowerCase()}:${String(sym).toUpperCase()}`;
}
export function keyObResultMapTs(mode) {
  return `ob:mapts:${String(mode || "bear").toLowerCase()}`;
}

export function keyDiagList(mode) {
  return `diag:list:${String(mode || "bear").toLowerCase()}`;
}
export function keyDiagSnap(mode) {
  return `diag:snap:${String(mode || "bear").toLowerCase()}`;
}

export const keyEntryLog = `logs:entry`;

// ================== helpers ==================
export function computeVm(volume, marketCap) {
  const v = Number(volume || 0);
  const m = Number(marketCap || 0);
  if (!(v > 0) || !(m > 0)) return 0;
  return v / m;
}

export function computeRangePct(high24, low24) {
  const hi = Number(high24 || 0);
  const lo = Number(low24 || 0);
  if (!(hi > 0) || !(lo > 0)) return 0;
  return ((hi - lo) / lo) * 100;
}

export function computeBtcState(btc, settings = SETTINGS) {
  const chg24 = Number(btc?.chg24 || 0);
  const bullMin = Number(settings?.btc?.bullMinChg24 ?? 1.0);
  const bearMax = Number(settings?.btc?.bearMaxChg24 ?? -1.0);

  if (chg24 >= bullMin) return "BULL";
  if (chg24 <= bearMax) return "BEAR";
  return "NEUTRAL";
}

export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;
  c += Math.max(0, Math.min(40, (vm / 0.30) * 40));
  c += Math.max(0, Math.min(25, (Math.abs(change24) / 12) * 25));
  c += Math.max(0, 20 - Math.min(20, range24 / 2));
  if (obValid) c += 15;
  return Math.max(0, Math.min(100, Math.round(c)));
}

function clamp(x, a, b) {
  const v = Number(x);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}

export function dynamicRadarThresholds(range24Pct, settings = SETTINGS) {
  const R = settings?.radar || {};
  const r = clamp(range24Pct, 0, 200);

  const s = clamp((r - 8) / (30 - 8), 0, 1);

  const base1hBull = Number(R.dir1hMinBull ?? 0.10);
  const base24Bull = Number(R.dir24MinBull ?? 0.25);

  const base1hBear = Number(R.dir1hMaxBear ?? -0.10);
  const base24Bear = Number(R.dir24MaxBear ?? -0.25);

  const bull1h = clamp(base1hBull * (0.75 + 0.9 * s), 0.05, 0.45);
  const bull24 = clamp(base24Bull * (0.75 + 0.9 * s), 0.15, 1.10);

  const bear1hAbs = clamp(Math.abs(base1hBear) * (0.75 + 0.9 * s), 0.05, 0.45);
  const bear24Abs = clamp(Math.abs(base24Bear) * (0.75 + 0.9 * s), 0.15, 1.10);

  const baseMaxRange = Number(R.maxRange24 ?? 85);
  const dynMaxRange = clamp(baseMaxRange + (s * 12 - 6), 55, 110);

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
    (Math.log10(vol + 1) - Math.log10(2_500_000 + 1)) /
      (Math.log10(60_000_000 + 1) - Math.log10(2_500_000 + 1)),
    0,
    1
  );

  const mcScore = clamp(
    (Math.log10(mc + 1) - Math.log10(15_000_000 + 1)) /
      (Math.log10(750_000_000 + 1) - Math.log10(15_000_000 + 1)),
    0,
    1
  );

  const vmScore = clamp((vmr - 0.10) / (0.60 - 0.10), 0, 1);

  const liq = clamp(0.55 * volScore + 0.30 * vmScore + 0.15 * mcScore, 0, 1);

  const spreadBase = Number(thr.spreadMaxPct ?? entry.spreadMaxPct ?? 1.95);
  const spreadAdj = (1 - liq) * 0.38 - liq * 0.10;
  let spreadMaxPct = spreadBase * (1 + spreadAdj);

  spreadMaxPct = clamp(spreadMaxPct, Number(dyn.spreadHardMinPct ?? 0.40), Number(dyn.spreadHardMaxPct ?? 2.8));

  const depthBase = Number(thr.depthMinUsd1p ?? entry.depthMinUsd1p ?? 10_000);
  const depthAdj = 0.72 + 0.70 * liq;
  let depthMinUsd1p = Math.round(depthBase * depthAdj);

  depthMinUsd1p = Math.round(
    clamp(depthMinUsd1p, Number(dyn.depthHardMinUsd ?? 5_500), Number(dyn.depthHardMaxUsd ?? 260_000))
  );

  const scoreBase = Number(thr.obScoreMin ?? entry.obScoreMin ?? 0.019);
  const scoreAdj = (1 - liq) * 0.25 - liq * 0.10;
  let obScoreMin = scoreBase * (1 + scoreAdj);

  obScoreMin = clamp(obScoreMin, Number(dyn.obScoreHardMin ?? 0.019), Number(dyn.obScoreHardMax ?? 0.070));

  return { ...thr, spreadMaxPct, depthMinUsd1p, obScoreMin, liqScore: liq };
}

// ---------- OB slope helpers ----------
function filterFreshSamples(samples, windowSec, field = "score") {
  const arr = Array.isArray(samples) ? samples : [];
  const win = Math.max(60, Number(windowSec || 0)) * 1000;
  const now = Date.now();

  return arr
    .map((s) => ({ ts: Number(s?.ts || 0), y: Number(s?.[field]) }))
    .filter((x) => x.ts > 0 && Number.isFinite(x.y))
    .filter((x) => now - x.ts <= win)
    .sort((a, b) => a.ts - b.ts);
}

export function calcSlopeFromSamplesPoints(points) {
  const pts = Array.isArray(points) ? points : [];
  if (pts.length < 4) return 0;

  const sorted = pts
    .map((p) => ({ t: Number(p?.ts || p?.t || 0), y: Number(p?.y) }))
    .filter((p) => p.t > 0 && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);

  if (sorted.length < 4) return 0;

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

export function checkObSlopeGate({ stage, mode, obSamples, settings = SETTINGS }) {
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
    return { ok: false, slope: 0, reason: `OB slope: insufficient FRESH samples in ${st} (${tail?.length || 0}/${minPts})` };
  }

  const slopeMin = m === "bull" ? Number(entryCfg.obSlopeMinBull || 0) : Number(entryCfg.obSlopeMinBear || 0);
  const slope = calcSlopeFromSamplesPoints(tail);

  if (!slopePass(m, slope, slopeMin)) {
    return { ok: false, slope, reason: `OB slope failed in ${st} (mode=${m}, slope=${slope.toFixed(6)}, min=${slopeMin})` };
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