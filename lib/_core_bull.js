import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

// ===============================
// MAIN BULL SETTINGS (SNIPER)
// Controlled Expansion Engine
// ===============================
export const SETTINGS = {
  CG_TOP: 250,
  RADAR_LIMIT: 60,

  // Radar filters (bull) — iets strenger, maar niet “dood”
  radar: {
    mcapMin: 15_000_000,
    mcapMax: 2_000_000_000,

    // Bull wil alleen echte liquiditeit
    volMin: 2_500_000,     // was 2_000_000
    vmMin: 0.12,           // was 0.10

    // Bull: geen extreme pump/dump chaos
    maxAbsChg24: 28,       // was 35
    maxRange24: 28         // was 35
  },

  // Entry / OB gate (bull) — SNIPER
  entry: {
    // 3 samples met 2x bevestiging = “structureel”
    samplesNeed: 3,        // was 2
    samplesWindowSec: 900, // 15 min window (past bij jouw scans)
    minAgree: 2,           // blijft 2 (maar nu op 3 samples)

    // Confidence omhoog = twijfel eruit
    minConfidence: 68,     // was 60

    // Orderbook quality (strenger)
    obScoreMin: 0.07,      // laat gelijk (jij hebt dit al als “prima baseline”)
    spreadMaxPct: 0.70,    // was 1.25
    depthMinUsd1p: 35_000  // was 60_000 (maar spread is nu strenger; dit maakt het haalbaar)
  },

  // BTC gate
  btc: {
    // Bull: in neutral mag je “soft open” laten (maar entry blijft streng)
    softOpenNeutral: true
  }
};

// ===============================
// KV keys (zelfde houden)
// ===============================
export function keyLatest(mode) { return `latest:${mode}`; }
export function keyState(mode) { return `state:${mode}`; }
export function keyReset(mode) { return `reset:${mode}`; }

export function keyObSamples(mode, sym) { return `ob:samples:${mode}:${String(sym).toUpperCase()}`; }
export function keyObResult(mode, sym) { return `ob:result:${mode}:${String(sym).toUpperCase()}`; }
export function keyObResultMapTs(mode) { return `ob:mapts:${mode}`; }

export const keyEntryLog = `logs:entry`;

// ===============================
// Helpers
// ===============================
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

// Confidence blijft hetzelfde model (stabiel), maar je drempel is nu 68
export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;

  // VM (0..40) — bull wil brandstof
  c += Math.max(0, Math.min(40, (vm / 0.30) * 40));

  // 24h change (0..25)
  c += Math.max(0, Math.min(25, (Math.abs(change24) / 12) * 25));

  // Range (0..20) — bull wil liever geen mega-range
  c += Math.max(0, 20 - Math.min(20, range24 / 2));

  // OB valid bonus (0..15)
  if (obValid) c += 15;

  return Math.max(0, Math.min(100, Math.round(c)));
}

// In jouw setup komt auth uit _runtime.js (zoals je al zei)
export function requireSecret(req, res) {
  return true;
}