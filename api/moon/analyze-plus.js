// In buildCopyBlockMoon, vervang filtersNow door:

    filtersNow: {
      universe: {
        CG_PER_PAGE: MOON.CG_PER_PAGE,
        CG_START_PAGE: MOON.CG_START_PAGE,
        CG_PAGES: MOON.CG_PAGES,
        RADAR_LIMIT: MOON.RADAR_LIMIT,
      },
      btcGate: {
        btcChgGate: MOON.btcChgGate,
        btcRangeMin: MOON.btcRangeMin,
        btcRangeMaxBull: MOON.btcRangeMaxBull,
        btcRangeMaxBear: MOON.btcRangeMaxBear,
      },
      caps: { mcapMin: MOON.mcapMin, mcapMax: MOON.mcapMax },
      radar: MOON.radar,
      buildup: MOON.buildup,
      almost: MOON.almost,
      elite: MOON.elite,
      tiers: MOON.tiers, // toegevoegd
      riskWhere: {
        file: "/lib/_moon_core.js",
        sltpFunc: "computeMoonRisk",
        hitFunc: "hitStopOrTp",
      },
    },