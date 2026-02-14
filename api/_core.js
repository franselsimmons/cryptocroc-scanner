// /api/_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs20.x" };

// ================== SETTINGS (v1 + fases 0/1/2) ==================
export const SETTINGS = {
  // Universe
  CG_TOP: 250,
  RADAR_LIMIT: 160,

  // RADAR (breed)
  mcapMin: 5_000_000,
  mcapMax: 400_000_000,
  volMinRadar: 500_000,
  vmMinRadar: 0.15,
  maxAbsChg24: 35,
  maxRange24: 30,

  // BTC gate
  btcChgGate: 0.8,
  btcRangeMin: 2,
  btcRangeMaxBull: 8,
  btcRangeMaxBear: 10,

  coinRangeCapMin: 25,
  coinRangeCapMax: 40,

  buildup: { chgMin: 1.2, vmMin: 0.22, volMin: 1_200_000 },
  almost: { vmMin: 0.26, volMin: 2_000_000, priceFlatMax: 6.5 },

  // ================= ENTRY =================
  entry: {
    obScoreMin: 0.06,
    spreadMaxPct: 0.55,
    largestOrderRatioMax: 0.35,
    samplesNeed: 3,
    samplesWindowSec: 90,
    minAgree: 2,

    // ✅ NIEUW – betrouwbaarheid
    minDepthUsd1p: 200_000,

    minConfidence: 70,
    entryConsistencyMin: 0.75,

    obSlopeEnabled: true,
    obSlopeMinBull: 0.0,
    obSlopeMaxBear: 0.0,
    obSlopeMinSamples: 3,
  },

  minScansPerStage: 2,

  consistencyWindowMin: 120,
  consistencyMinRatio: 0.67,
  consistencyMinSamples: 6,

  obPickAlmost: 12,
  obPickBuildup: 8,

  cgCacheSec: 600,
  atrCacheSec: 600,
};