export const CFG = {
  cg: {
    vs: "usd",
    order: "volume_desc",
    perPage: 250,
    pages: 1,              // Vercel-safe
    delayMs: 400
  },

  pool: {
    mcapMin: 3_000_000,
    mcapMax: 400_000_000,
    volMin: 250_000,
    vmMin: 0.10
  },

  bands: {
    bull: { min: -8,  max: 15 },
    bear: { min: -15, max: 3.5 }
  },

  stageMin: {
    RADAR:   { volMin: 250_000,  vmMin: 0.10 },
    BUILDUP: { volMin: 500_000,  vmMin: 0.14 },
    ALMOST:  { volMin: 1_000_000,vmMin: 0.16 },
    ENTRY:   { volMin: 1_500_000,vmMin: 0.28 }
  },

  funnel: {
    minScansToLeaveRadar: 2,
    minBuildUpScans: 3,
    minTotalScansForEntry: 5,
    promoteOneStep: true,
    demoteOneStep: true
  },

  engines: {
    EXPLOSIE: {
      buildUpVolAccMin: 0.20,
      entryVolAccMin: 0.30,
      priceFlatMax: 4.0,
      entryObMinBull: 0.12,
      entryObMinBear: -0.12
    },
    ACCUMULATIE: {
      priceFlatMax: 3.0,
      buildUpVolAccMin: 0.10,
      entryObMinBull: 0.00,
      entryObMinBear: 0.00
    }
  },

  ob: {
    depthLimit: 20,
    depthPct: 0.02,
    maxCallsPerScan: 30,      // OB vanaf ALMOST + ENTRY, maar capped
    sellSpreadPct: 0.35,
    holdSpreadPct: 0.28,
    bullHoldScore: 0.18,
    bullSellScore: -0.10,
    bearHoldScore: -0.18,
    bearSellScore: 0.10
  }
};
