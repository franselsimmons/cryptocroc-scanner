// lib/_thresholds.js
// Single source of truth voor alle thresholds

export const THRESHOLDS = {
  // Algemene scores (advies uit de analyse)
  market: {
    current: 45,
    advised: 55,
  },
  timing: {
    current: 60,
    advised: 65,
  },
  quality: {
    current: 60,
    advised: 68,
  },
  btcAlignment: {
    current: 50,
    advised: 55,
  },
  exit: {
    giveback: 1.5,
  },

  // Main-specifieke drempels
  main: {
    // tradeCandidate
    perfectCandidate: 76,
    qualityScore: 68,
    timingScore: 71,
    liquidityScore: 66,
    marketScore: 56,
    btcAlignmentScore: 55,

    // entryReady in state machine (extra checks)
    entryReady: {
      perfectCandidate: 70,
      qualityScore: 62,
      timingScore: 64,
      liquidityScore: 58,
      marketScore: 44,
      breakoutPressure: 54,
    },

    // nearEntryWatch
    nearEntryWatch: {
      entryQuality: 70,
      persistenceScore: 60,
      breakoutPressure: 63,
      obScore: 0.01,
    },

    // stableWatchReady
    stableWatch: {
      entryQuality: 64,
      persistence: 56,
      breakoutPressure: 59,
    },

    // execution decision
    execution: {
      entryQuality: 68,
      persistence: 60,
      breakoutPressure: 63,
    },

    // execution score thresholds (tradeDeskStatus)
    executionScore: {
      eliteOpen: 62,
      almostOpen: 60,
    },

    // superScanner
    superScanner: {
      perfectCandidate: 74,
      qualityScore: 68,
    },

    // filters
    filters: {
      obScore: 0.008,
      spread: 0.90,
    },
  },

  // Moon-specifieke drempels
  moon: {
    // tradeCandidate
    perfectCandidate: 72,
    qualityScore: 68,
    timingScore: 67,
    liquidityScore: 62,
    marketScore: 52,
    btcAlignmentScore: 55,

    // entryReady
    entryReady: {
      perfectCandidate: 66,
      qualityScore: 58,
      timingScore: 60,
      liquidityScore: 54,
      marketScore: 40,
      breakoutPressure: 52,
    },

    // nearEntryWatch
    nearEntryWatch: {
      entryQuality: 66,
      persistenceScore: 56,
      breakoutPressure: 61,
      obScore: 0.008,
    },

    // stableWatchReady
    stableWatch: {
      entryQuality: 60,
      persistence: 52,
      breakoutPressure: 57,
    },

    // execution decision
    execution: {
      entryQuality: 64,
      persistence: 56,
      breakoutPressure: 61,
    },

    // execution score thresholds (tradeDeskStatus)
    executionScore: {
      eliteOpen: 58,
      almostOpen: 56,
    },

    // superScanner
    superScanner: {
      perfectCandidate: 72,
      qualityScore: 68,
    },

    // filters
    filters: {
      obScore: 0.008,
      spread: 0.80,
    },
  },
};