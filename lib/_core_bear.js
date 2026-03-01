/* EOF: /lib/_core_bear.js */
import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

// ================== SETTINGS (30m cadence - soepeler OB) ==================
export const SETTINGS = {
  CG_TOP: 250,
  RADAR_LIMIT: 60,

  // ✅ RADAR strenger = minder noise binnen
  radar: {
    mcapMin: 15_000_000,
    mcapMax: 2_000_000_000,

    // strenger
    volMin: 3_000_000,     // was 2_000_000
    vmMin: 0.12,           // was 0.10
    maxAbsChg24: 30,       // was 35
    maxRange24: 30,        // was 35
  },

  // ✅ ENTRY/ALMOST soepeler = makkelijker doorstromen, maar nog steeds met OB + slope controle
  entry: {
    samplesNeed: 4,
    samplesWindowSec: 3 * 3600,
    samplesMax: 24,

    samplesTtlSec: 60 * 60 * 48,
    resultTtlSec: 60 * 45,

    // soepeler
    minAgree: 2,           // was 3
    minConfidence: 56,     // was 58

    obScoreMin: 0.04,
    spreadMaxPct: 1.20,
    depthMinUsd1p: 30_000,

    // ✅ adaptive tiers: iets soepeler (vooral smallcaps), largecaps blijven relatief streng
    adaptiveTiers: [
      { maxMc: 50_000_000,  minConf: 58, spreadMax: 1.80, depth1pMin: 1_200,  obScoreMin: 0.045 },
      { maxMc: 200_000_000, minConf: 58, spreadMax: 1.15, depth1pMin: 15_000, obScoreMin: 0.045 },
      { maxMc: 1_000_000_000, minConf: 60, spreadMax: 0.95, depth1pMin: 50_000, obScoreMin: 0.055 },
      { maxMc: Infinity,    minConf: 62, spreadMax: 0.85, depth1pMin: 100_000, obScoreMin: 0.065 },
    ],

    obSlopeEnabled: true,

    // soepeler slope (minder vaak "insufficient slope" / fail)
    obSlopeMinBull: 0.00030, // was 0.00035
    obSlopeMinBear: 0.00030, // was 0.00035

    obSlopeField: "score",
  },

  btc: {
    softOpenNeutral: true,
    bullMinChg24: 1.0,
    bearMaxChg24: -1.0,
  },
};

// ✅ analyzer gebruikt dit
export function getCfg() {
  return SETTINGS;
}

// ================== KV keys (latest/state/reset) ==================
export function keyLatest(mode) { return `latest:${mode}`; }
export function keyState(mode) { return `state:${mode}`; }
export function keyReset(mode) { return `reset:${mode}`; }

// ================== KV keys (orderbook) ==================
export function keyObSamples(mode, sym) {
  return `ob:samples:${mode}:${String(sym).toUpperCase()}`;
}
export function keyObResult(mode, sym) {
  return `ob:result:${mode}:${String(sym).toUpperCase()}`;
}
export function keyObResultMapTs(mode) { return `ob:mapts:${mode}`; }

// ================== Diagnostics keys (voor analyze.js) ==================
export function keyDiagList(mode) { return `diag:list:${String(mode || "bear")}`; }
export function keyDiagSnap(mode) { return `diag:snap:${String(mode || "bear")}`; }

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

// ---------- SWING helpers ----------
function filterFreshSamples(samples, windowSec, field = "score") {
  const arr = Array.isArray(samples) ? samples : [];
  const win = Math.max(60, Number(windowSec || 0)) * 1000;
  const now = Date.now();

  return arr
    .map((s) => ({
      ts: Number(s?.ts || 0),
      y: Number(s?.[field]),
    }))
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

  const minPts = Math.max(4, need);
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