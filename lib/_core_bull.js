import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

export const SETTINGS = {
  // ✅ MAXIMALE UNIVERSE (wordt nu uit universe:latest gehaald, maar CG_TOP bepaalt slice)
  CG_TOP: 1500, // 6 * 250

  RADAR_LIMIT: 60,

  radar: {
    mcapMin: 12_000_000,
    mcapMax: 500_000_000,
    volMin: 2_000_000,
    vmMin: 0.10,

    maxAbsChg24: 35,
    maxRange24: 34,

    dir1hMinBull: 0.10,
    dir24MinBull: 0.25,
    dir1hMaxBear: -0.10,
    dir24MaxBear: -0.25,
  },

  entry: {
    samplesNeed: 2,
    samplesWindowSec: 3 * 3600,
    samplesMax: 24,

    samplesTtlSec: 60 * 60 * 48,
    resultTtlSec: 60 * 45,

    minAgree: 2,
    minConfidence: 50,

    obScoreMin: 0.034,
    spreadMaxPct: 1.30,
    depthMinUsd1p: 22_000,

    adaptiveTiers: [
      { maxMc: 60_000_000,  minConf: 52, spreadMax: 1.50, depth1pMin: 15_000, obScoreMin: 0.032 },
      { maxMc: 200_000_000, minConf: 50, spreadMax: 1.30, depth1pMin: 22_000, obScoreMin: 0.034 },
      { maxMc: 500_000_000, minConf: 48, spreadMax: 1.12, depth1pMin: 34_000, obScoreMin: 0.040 },
    ],

    obSlopeEnabled: true,
    obSlopeMinBull: 0.00010,
    obSlopeMinBear: 0.00010,
    obSlopeField: "score",

    dyn: {
      spreadHardMaxPct: 2.0,
      spreadHardMinPct: 0.45,
      depthHardMinUsd: 8_000,
      depthHardMaxUsd: 180_000,
      obScoreHardMin: 0.028,
      obScoreHardMax: 0.070,
    },
  },

  btc: {
    softOpenNeutral: true,
    bullMinChg24: 1.0,
    bearMaxChg24: -1.0,
  },
};

export function getCfg() {
  return SETTINGS;
}

export function keyLatest(mode) { return `latest:${mode}`; }
export function keyState(mode) { return `state:${mode}`; }
export function keyReset(mode) { return `reset:${mode}`; }

export function keyObSamples(mode, sym) {
  return `ob:samples:${mode}:${String(sym).toUpperCase()}`;
}
export function keyObResult(mode, sym) {
  return `ob:result:${mode}:${String(sym).toUpperCase()}`;
}
export function keyObResultMapTs(mode) { return `ob:mapts:${mode}`; }

export function keyDiagList(mode) { return `diag:list:${String(mode || "bull")}`; }
export function keyDiagSnap(mode) { return `diag:snap:${String(mode || "bull")}`; }

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

// ================== coin-adaptive radar thresholds ==================
function clamp(x, a, b) {
  const v = Number(x);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}

export function dynamicRadarThresholds(range24Pct, settings = SETTINGS) {
  const R = settings?.radar || {};
  const r = clamp(range24Pct, 0, 200);

  const s = clamp((r - 8) / (30 - 8), 0, 1);

  const base1hBull = Number(R.dir1hMinBull ?? 0.15);
  const base24Bull = Number(R.dir24MinBull ?? 0.35);

  const base1hBear = Number(R.dir1hMaxBear ?? -0.15);
  const base24Bear = Number(R.dir24MaxBear ?? -0.35);

  const bull1h = clamp(base1hBull * (0.75 + 0.9 * s), 0.08, 0.40);
  const bull24 = clamp(base24Bull * (0.75 + 0.9 * s), 0.18, 0.95);

  const bear1hAbs = clamp(Math.abs(base1hBear) * (0.75 + 0.9 * s), 0.08, 0.40);
  const bear24Abs = clamp(Math.abs(base24Bear) * (0.75 + 0.9 * s), 0.18, 0.95);

  const baseMaxRange = Number(R.maxRange24 ?? 30);
  const dynMaxRange = clamp(baseMaxRange + (s * 6 - 4), 24, 36);

  return {
    maxRange24: dynMaxRange,
    dir1hMinBull: bull1h,
    dir24MinBull: bull24,
    dir1hMaxBear: -bear1hAbs,
    dir24MaxBear: -bear24Abs,
    scale: s,
  };
}

// ================== coin-adaptive entry thresholds (OB) ==================
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
      (Math.log10(450_000_000 + 1) - Math.log10(15_000_000 + 1)),
    0,
    1
  );

  const vmScore = clamp((vmr - 0.12) / (0.60 - 0.12), 0, 1);

  const liq = clamp(0.55 * volScore + 0.30 * vmScore + 0.15 * mcScore, 0, 1);

  const spreadBase = Number(thr.spreadMaxPct ?? entry.spreadMaxPct ?? 1.10);
  const spreadAdj = (1 - liq) * 0.35 - liq * 0.10;
  let spreadMaxPct = spreadBase * (1 + spreadAdj);

  spreadMaxPct = clamp(
    spreadMaxPct,
    Number(dyn.spreadHardMinPct ?? 0.50),
    Number(dyn.spreadHardMaxPct ?? 1.8)
  );

  const depthBase = Number(thr.depthMinUsd1p ?? entry.depthMinUsd1p ?? 32_000);
  const depthAdj = 0.75 + 0.65 * liq;
  let depthMinUsd1p = Math.round(depthBase * depthAdj);

  depthMinUsd1p = Math.round(
    clamp(
      depthMinUsd1p,
      Number(dyn.depthHardMinUsd ?? 10_000),
      Number(dyn.depthHardMaxUsd ?? 160_000)
    )
  );

  const scoreBase = Number(thr.obScoreMin ?? entry.obScoreMin ?? 0.04);
  const scoreAdj = (1 - liq) * 0.25 - liq * 0.10;
  let obScoreMin = scoreBase * (1 + scoreAdj);

  obScoreMin = clamp(
    obScoreMin,
    Number(dyn.obScoreHardMin ?? 0.035),
    Number(dyn.obScoreHardMax ?? 0.070)
  );

  return {
    ...thr,
    spreadMaxPct,
    depthMinUsd1p,
    obScoreMin,
    liqScore: liq,
  };
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

  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
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

  // ✅ Aangepast: nu 3 i.p.v. 4 (voor soepelere doorstroom)
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