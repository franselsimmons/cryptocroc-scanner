// /lib/_core_bear.js
import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

export const SETTINGS = {
  CG_TOP: 250,
  RADAR_LIMIT: 60,

  radar: {
    mcapMin: 15_000_000,
    mcapMax: 2_000_000_000,
    volMin: 2_000_000,
    vmMin: 0.10,
    maxAbsChg24: 35,
    maxRange24: 35,
  },

  entry: {
    // ✅ was 2 -> veel te ruisig
    samplesNeed: 8,
    // ✅ was 900 (15m) -> te kort voor hobby refresh
    samplesWindowSec: 5400, // 90 min
    // ✅ keep max samples in KV (sampler gebruikt dit)
    samplesMax: 18,
    // ✅ TTLs (sampler gebruikt dit)
    samplesTtlSec: 60 * 60 * 48,
    resultTtlSec: 60 * 20,

    minAgree: 6,
    minConfidence: 60,

    obScoreMin: 0.07,
    spreadMaxPct: 1.25,
    depthMinUsd1p: 60_000,

    // ✅ OB slope sniper
    obSlopeEnabled: true,
    // slope per minuut (regressie). Bear moet NEGATIEF zijn.
    obSlopeMinBull: 0.0008, // staat hier zodat helper 1 shape heeft
    obSlopeMinBear: 0.0008, // verplicht NEGATIEF
  },

  btc: {
    softOpenNeutral: true,
  },
};

// KV keys (latest/state/reset)
export function keyLatest(mode) { return `latest:${mode}`; }
export function keyState(mode) { return `state:${mode}`; }
export function keyReset(mode) { return `reset:${mode}`; }

// KV keys (orderbook)
export function keyObSamples(mode, sym) { return `ob:samples:${mode}:${String(sym).toUpperCase()}`; }
export function keyObResult(mode, sym) { return `ob:result:${mode}:${String(sym).toUpperCase()}`; }
export function keyObResultMapTs(mode) { return `ob:mapts:${mode}`; }

// Diagnostics keys (voor analyze.js)
export function keyDiagList(mode) { return `diag:list:${String(mode || "bear")}`; }
export function keyDiagSnap(mode) { return `diag:snap:${String(mode || "bear")}`; }

export const keyEntryLog = `logs:entry`;

export function computeVm(volume, marketCap) {
  const v = Number(volume || 0);
  const m = Number(marketCap || 0);
  if (!(v > 0) || !(m > 0)) return 0;
  return v / m;
}

// zelfde confidence model (simpel en stabiel)
export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;
  c += Math.max(0, Math.min(40, (vm / 0.30) * 40));
  c += Math.max(0, Math.min(25, (Math.abs(change24) / 12) * 25));
  c += Math.max(0, 20 - Math.min(20, range24 / 2));
  if (obValid) c += 15;
  return Math.max(0, Math.min(100, Math.round(c)));
}

/**
 * ✅ Slope via lineaire regressie (score over tijd)
 * Output: slope per minuut.
 */
export function calcSlopeFromSamples(samples) {
  const arr = Array.isArray(samples) ? samples : [];
  if (arr.length < 6) return 0;

  const pts = arr
    .map((s) => ({ t: Number(s?.ts || 0), y: Number(s?.score) }))
    .filter((p) => p.t > 0 && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);

  if (pts.length < 6) return 0;

  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 60000); // minuten sinds start
  const ys = pts.map(p => p.y);

  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den; // per minuut
}

export function slopePass(mode, slope, slopeMin) {
  const m = String(mode || "").toLowerCase();
  const sMin = Number(slopeMin || 0);
  if (m === "bull") return slope >= sMin;
  if (m === "bear") return slope <= -sMin;
  return false;
}

export function extractTailSamples(samples, need) {
  const n = Math.max(0, Number(need || 0));
  const arr = Array.isArray(samples) ? samples : [];
  return n > 0 ? arr.slice(-n) : arr;
}

export function checkObSlopeGate({ stage, mode, obSamples, settings = SETTINGS }) {
  const m = String(mode || "bear").toLowerCase();
  const st = String(stage || "entry").toLowerCase();

  const entryCfg = settings?.entry || {};
  const enabled = !!entryCfg.obSlopeEnabled;

  if (!enabled) return { ok: true, slope: 0, reason: "disabled" };

  const need = Number(entryCfg.samplesNeed || 0);
  const tail = extractTailSamples(obSamples, need);

  if (!Array.isArray(tail) || tail.length < Math.max(6, need)) {
    return {
      ok: false,
      slope: 0,
      reason: `OB slope: insufficient samples in ${st} (${tail?.length || 0}/${need})`,
    };
  }

  const slopeMin = m === "bull"
    ? Number(entryCfg.obSlopeMinBull || 0)
    : Number(entryCfg.obSlopeMinBear || 0);

  const slope = calcSlopeFromSamples(tail);

  if (!slopePass(m, slope, slopeMin)) {
    return {
      ok: false,
      slope,
      reason: `OB slope failed in ${st} (mode=${m}, slope=${slope.toFixed(6)}, min=${slopeMin})`,
    };
  }

  return { ok: true, slope, reason: "OK" };
}