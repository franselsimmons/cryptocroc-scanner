// lib/_thresholds.js
export const THRESHOLDS = {
  market: { current: 45, advised: 55 },
  timing: { current: 60, advised: 65 },
  quality: { current: 60, advised: 68 },
  btcAlignment: { current: 50, advised: 55 },

  exit: {
    giveback: 1.5,
  },

  main: {
    perfectCandidate: 76,
    qualityScore: 68,
    timingScore: 71,
    liquidityScore: 66,
    marketScore: 56,
    btcAlignmentScore: 55,

    entryReady: {
      perfectCandidate: 70,
      qualityScore: 62,
      timingScore: 64,
      liquidityScore: 58,
      marketScore: 44,
      breakoutPressure: 54,
    },

    nearEntryWatch: {
      entryQuality: 70,
      persistenceScore: 60,
      breakoutPressure: 63,
      obScore: 0.01,
    },

    stableWatch: {
      entryQuality: 64,
      persistence: 56,
      breakoutPressure: 59,
    },

    execution: {
      entryQuality: 68,
      persistence: 60,
      breakoutPressure: 63,
    },

    executionScore: {
      eliteOpen: 62,
      almostOpen: 60,
    },

    superScanner: {
      perfectCandidate: 74,
      qualityScore: 68,
    },

    filters: {
      obScore: 0.008,
      spread: 0.9,
    },
  },

  moon: {
    perfectCandidate: 72,
    qualityScore: 68,
    timingScore: 67,
    liquidityScore: 62,
    marketScore: 52,
    btcAlignmentScore: 55,

    entryReady: {
      perfectCandidate: 66,
      qualityScore: 58,
      timingScore: 60,
      liquidityScore: 54,
      marketScore: 40,
      breakoutPressure: 52,
    },

    nearEntryWatch: {
      entryQuality: 66,
      persistenceScore: 56,
      breakoutPressure: 61,
      obScore: 0.008,
    },

    stableWatch: {
      entryQuality: 60,
      persistence: 52,
      breakoutPressure: 57,
    },

    execution: {
      entryQuality: 64,
      persistence: 56,
      breakoutPressure: 61,
    },

    executionScore: {
      eliteOpen: 58,
      almostOpen: 56,
    },

    superScanner: {
      perfectCandidate: 72,
      qualityScore: 68,
    },

    filters: {
      obScore: 0.008,
      spread: 0.8,
    },
  },
};