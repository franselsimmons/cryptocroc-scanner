/* EOF: /lib/_core_bull.js */
import { RUNTIME_CONFIG } from "./_runtime.js";

export const config = RUNTIME_CONFIG;

export const SETTINGS = {
  // ✅ MAXIMALE UNIVERSE (hard capped in scan.js op 2500)
  CG_TOP: 2500,

  RADAR_LIMIT: 60,

  radar: {
    mcapMin: 20_000_000,
    mcapMax: 400_000_000,
    volMin: 3_500_000,
    vmMin: 0.14,

    maxAbsChg24: 25,
    maxRange24: 28,

    dir1hMinBull: 0.20,
    dir24MinBull: 0.50,
    dir1hMaxBear: -0.20,
    dir24MaxBear: -0.50,
  },

  entry: {
    samplesNeed: 4,
    samplesWindowSec: 3 * 3600,
    samplesMax: 24,

    samplesTtlSec: 60 * 60 * 48,
    resultTtlSec: 60 * 45,

    minAgree: 3,
    minConfidence: 60,

    obScoreMin: 0.05,
    spreadMaxPct: 0.95,
    depthMinUsd1p: 45_000,

    adaptiveTiers: [
      { maxMc: 60_000_000,  minConf: 62, spreadMax: 1.20, depth1pMin: 25_000, obScoreMin: 0.05 },
      { maxMc: 200_000_000, minConf: 60, spreadMax: 0.95, depth1pMin: 45_000, obScoreMin: 0.055 },
      { maxMc: 400_000_000, minConf: 58, spreadMax: 0.80, depth1pMin: 70_000, obScoreMin: 0.06 },
    ],

    obSlopeEnabled: true,
    obSlopeMinBull: 0.00035,
    obSlopeMinBear: 0.00035,
    obSlopeField: "score",

    dyn: {
      spreadHardMaxPct: 1.6,
      spreadHardMinPct: 0.55,
      depthHardMinUsd: 12_000,
      depthHardMaxUsd: 140_000,
      obScoreHardMin: 0.04,
      obScoreHardMax: 0.075,
    },
  },

  btc: {
    softOpenNeutral: true,
    bullMinChg24: 1.0,
    bearMaxChg24: -1.0,
  },
};