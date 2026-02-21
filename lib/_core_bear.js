import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

export const SETTINGS = {
  CG_TOP: 250,
  RADAR_LIMIT: 60,

  // Radar filters (bear)
  radar: {
    mcapMin: 15_000_000,
    mcapMax: 2_000_000_000,
    volMin: 2_000_000,
    vmMin: 0.10,
    maxAbsChg24: 35,
    maxRange24: 35,
  },

  // Entry / OB gate (bear)
  entry: {
    samplesNeed: 2,
    samplesWindowSec: 900,
    minAgree: 2,
    minConfidence: 60,

    obScoreMin: 0.07,
    spreadMaxPct: 1.25,
    depthMinUsd1p: 60_000,

    // ✅ OB slope sniper (vanaf ALMOST + opnieuw bij ENTRY)
    obSlopeEnabled: true,
    obSlopeMinBull: 0.015, // (staat hier zodat helper altijd dezelfde velden gebruikt)
    obSlopeMinBear: 0.015, // verplicht negatief
  },

  btc: {
    softOpenNeutral: true,
  },
};

export function keyLatest(mode) {
  return `latest:${mode}`;
}
export function keyState(mode) {
  return `state:${mode}`;
}
export function keyReset(mode) {
  return `reset:${mode}`;
}

export function keyObSamples(mode, sym) {
  return `ob:samples:${mode}:${String(sym).toUpperCase()}`;
}
export function keyObResult(mode, sym) {
  return `ob:result:${mode}:${String(sym).toUpperCase()}`;
}
export function keyObResultMapTs(mode) {
  return `ob:mapts:${mode}`;
}

export const keyEntryLog = `logs:entry`;

export function computeVm(volume, marketCap) {
  const v = Number(volume || 0);
  const m = Number(marketCap || 0);
  if (!(v > 0) || !(m > 0)) return 0;
  return v / m;
}

// bear gebruikt zelfde confidence model als bull (simpel en stabiel)
export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;
  c += Math.max(0, Math.min(40, (vm / 0.30) * 40));
  c += Math.max(0, Math.min(25, (Math.abs(change24) / 12) * 25));
  c += Math.max(0, 20 - Math.min(20, range24 / 2));
  if (obValid) c += 15;
  return Math.max(0, Math.min(100, Math.round(c)));
}

/**
 * ✅ OB SLOPE helpers (ob.score)
 */

// verschil laatste - eerste
export function calcSlope(scores) {
  if (!Array.isArray(scores) || scores.length < 2) return 0;
  return Number(scores[scores.length - 1]) - Number(scores[0]);
}

export function slopePass(mode, scores, slopeMin) {
  const m = String(mode || "").toLowerCase();
  const slope = calcSlope(scores);

  if (m === "bull") return slope >= Number(slopeMin || 0);
  if (m === "bear") return slope <= -Number(slopeMin || 0);

  return false;
}

export function extractObScoresFromSamples(samples, need) {
  const n = Math.max(0, Number(need || 0));
  const arr = Array.isArray(samples) ? samples : [];
  const tail = n > 0 ? arr.slice(-n) : arr;

  const scores = [];
  for (const s of tail) {
    const v = Number(s?.score);
    if (Number.isFinite(v)) scores.push(v);
  }
  return scores;
}

export function checkObSlopeGate({ stage, mode, obSamples, settings = SETTINGS }) {
  const m = String(mode || "bear").toLowerCase();
  const st = String(stage || "entry").toLowerCase();

  const entryCfg = settings?.entry || {};
  const enabled = !!entryCfg.obSlopeEnabled;

  if (!enabled) {
    return { ok: true, slope: 0, scores: [] };
  }

  const need = Number(entryCfg.samplesNeed || 0);
  const scores = extractObScoresFromSamples(obSamples, need);

  if (scores.length < need) {
    return {
      ok: false,
      slope: 0,
      scores,
      reason: `OB slope: insufficient samples in ${st} (${scores.length}/${need})`,
    };
  }

  const slopeMin = m === "bull"
    ? Number(entryCfg.obSlopeMinBull || 0)
    : Number(entryCfg.obSlopeMinBear || 0);

  const slope = calcSlope(scores);

  const pass = slopePass(m, scores, slopeMin);
  if (!pass) {
    return {
      ok: false,
      slope,
      scores,
      reason: `OB slope failed in ${st} (mode=${m}, slope=${slope.toFixed(4)}, min=${slopeMin})`,
    };
  }

  return { ok: true, slope, scores };
}