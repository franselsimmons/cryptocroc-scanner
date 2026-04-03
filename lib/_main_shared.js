// lib/_main_shared.js
// Shared helpers for MAIN (non-moon) endpoints.
// This file exists so MAIN doesn't need to import from _moon_core.js by name.

export {
  RUNTIME_CONFIG,
  requireSecret,

  // data sources
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,

  // KV keys used by MAIN latest/state
  keyMainLatest,
  keyMainState,
  keyMainPortfolio,
  keyMainPositions,
} from "./_moon_core.js";