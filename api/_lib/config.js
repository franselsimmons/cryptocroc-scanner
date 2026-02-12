// Hier staat alles wat “instellingen” zijn.
// We houden het bewust simpel en stabiel.

export const CFG = {
  cg: { vs: "usd", order: "volume_desc", perPage: 250, pages: 2, delayMs: 900 },

  pool: { mcapMin: 3_000_000, mcapMax: 400_000_000, volMin: 250_000, vmMin: 0.10 },

  // side selectie op bands (fix #2)
  bands: {
    bull: { ch24Min: -8, ch24Max: 15 },
    bear: { ch24Min: -15, ch24Max: 3.5 }
  },

  // stage minima (fix #3)
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
    EXPLOSIE: { buildUpVolAccMin: 0.20, entryVolAccMin: 0.30, priceFlatMax: 4.0, entryObMinBull: 0.12, entryObMinBear: -0.12 },
    ACCUMULATIE:{ buildUpVolAccMin: 0.10, priceFlatMax: 3.0, entryObMinBull: 0.00, entryObMinBear:  0.00 }
  },

  ob: {
    depthLimit: 20,
    depthPct: 0.02,
    maxCallsPerScan: 35
  },

  regime: {
    btcRangeHighVol: 4.5
  }
};
