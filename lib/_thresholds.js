// lib/_thresholds.js

// ==============================
// 1) Base thresholds (globaal)
// ==============================
export const BASE_THRESHOLDS = {
  market: 45,
  timing: 60,
  quality: 60,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ============================================
// 2) Adaptive engine (performance-aware)
// ============================================
export function buildAdaptiveThresholds({ performance, regime }) {
  const winRate = performance?.winRate ?? 50;
  const drawdown = performance?.drawdown ?? 0;

  let timing = BASE_THRESHOLDS.timing;
  let quality = BASE_THRESHOLDS.quality;
  let market = BASE_THRESHOLDS.market;

  // 🔴 Lage winrate → strenger
  if (winRate < 45) {
    timing += 4;
    quality += 5;
    market += 4;
  }
  if (winRate < 35) {
    timing += 3;
    quality += 4;
  }

  // 🔴 Hoge drawdown → veel strenger
  if (drawdown > 40) {
    timing += 6;
    quality += 6;
    market += 5;
  }
  if (drawdown > 55) {
    timing += 4;
    quality += 4;
  }

  // 🟢 Sterke performance → iets losser
  if (winRate > 60 && drawdown < 15) {
    timing -= 3;
    quality -= 3;
    market -= 2;
  }

  // 🌪 Regime aware
  const reg = String(regime || "").toUpperCase();

  if (reg === "HEADWIND") {
    market += 6; // extra streng tegen BTC trend in
  }
  if (reg === "EXPANSION") {
    timing -= 2; // sneller entries in expansion
  }

  return {
    timing: clamp(timing, 58, 75),
    quality: clamp(quality, 60, 78),
    market: clamp(market, 45, 65),
  };
}

// ======================================================
// 3) Je bestaande THRESHOLDS structuur (behouden)
//    -> zodat je project niet crasht
// ======================================================
export const THRESHOLDS = {
  market: { current: BASE_THRESHOLDS.market, advised: 55 },
  timing: { current: BASE_THRESHOLDS.timing, advised: 65 },
  quality: { current: BASE_THRESHOLDS.quality, advised: 68 },
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