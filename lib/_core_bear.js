import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

// ===============================
// MAIN BEAR SETTINGS
// Acceleration Engine
// ===============================
export const SETTINGS = {
  CG_TOP: 250,
  RADAR_LIMIT: 60,

  // Radar filters (bear) — iets “sneller” en minder streng dan bull
  radar: {
    mcapMin: 15_000_000,
    mcapMax: 2_000_000_000,

    // Bear: panic volume telt, maar hoeft niet altijd mega te zijn
    volMin: 2_000_000,   // laat gelijk
    vmMin: 0.11,         // iets omhoog t.o.v. 0.10, maar lager dan bull

    // Bear: mag iets ruiger zijn, want moves zijn agressiever
    maxAbsChg24: 35,     // laat gelijk
    maxRange24: 35       // laat gelijk
  },

  // Entry / OB gate (bear) — sneller dan bull
  entry: {
    // Bear wil sneller triggeren
    samplesNeed: 2,        // blijft 2
    samplesWindowSec: 900,
    minAgree: 1,           // was 2 → sneller (minder “wachten”)

    // Confidence iets lager dan bull
    minConfidence: 60,     // blijft 60

    // Orderbook quality (bear iets ruimer)
    obScoreMin: 0.07,
    spreadMaxPct: 1.00,    // was 1.25 → nog steeds beheersbaar
    depthMinUsd1p: 22_000  // bear mag dunner, je wil sneller in/uit
  },

  btc: {
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

// Zelfde confidence model als bull (stabiel), alleen drempels verschillen via SETTINGS.entry.minConfidence
export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;
  c += Math.max(0, Math.min(40, (vm / 0.30) * 40));
  c += Math.max(0, Math.min(25, (Math.abs(change24) / 12) * 25));
  c += Math.max(0, 20 - Math.min(20, range24 / 2));
  if (obValid) c += 15;
  return Math.max(0, Math.min(100, Math.round(c)));
}

export function requireSecret(req, res) {
  return true;
}