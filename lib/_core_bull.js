import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

export const SETTINGS = {
  CG_TOP: 250,
  RADAR_LIMIT: 60,

  // Radar filters (bull)
  radar: {
    mcapMin: 15_000_000,
    mcapMax: 2_000_000_000,
    volMin: 2_000_000,
    vmMin: 0.10,
    maxAbsChg24: 35,
    maxRange24: 35
  },

  // Entry / OB gate (bull)
  entry: {
    samplesNeed: 2,
    samplesWindowSec: 900,
    minAgree: 2,
    minConfidence: 60,

    // orderbook quality
    obScoreMin: 0.07,
    spreadMaxPct: 1.25,
    depthMinUsd1p: 60_000
  },

  // BTC gate
  btc: {
    softOpenNeutral: true
  }
};

export function keyLatest(mode) { return `latest:${mode}`; }
export function keyState(mode) { return `state:${mode}`; }
export function keyReset(mode) { return `reset:${mode}`; }

export function keyObSamples(mode, sym) { return `ob:samples:${mode}:${String(sym).toUpperCase()}`; }
export function keyObResult(mode, sym) { return `ob:result:${mode}:${String(sym).toUpperCase()}`; }
export function keyObResultMapTs(mode) { return `ob:mapts:${mode}`; }

export const keyEntryLog = `logs:entry`;

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

export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;

  // VM (0..40)
  c += Math.max(0, Math.min(40, (vm / 0.30) * 40));

  // 24h change (0..25)
  c += Math.max(0, Math.min(25, (Math.abs(change24) / 12) * 25));

  // Range (0..20) -> liever niet mega range
  c += Math.max(0, 20 - Math.min(20, range24 / 2));

  // OB valid bonus (0..15)
  if (obValid) c += 15;

  return Math.max(0, Math.min(100, Math.round(c)));
}

export function requireSecret(req, res) {
  // doorlinken naar runtime helper (importen via dynamic import in api files)
  // (we exporten hem hier niet dubbel; api files importen requireSecret uit _runtime.js)
  return true;
}